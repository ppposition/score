import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { runGradingAgent, type GradeOptions } from "../src/agent/grade.js";
import { GradingBatchManager } from "../src/agent/subagents/manager.js";
import type { Submission } from "../src/api/types.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
const submission = (id: number): Submission => ({ id, user_id: id, grade: id === 1 ? "10" : null, score: id === 1 ? 10 : null,
  submitted_at: "2026-10-08T00:00:00Z", late: false, workflow_state: id === 1 ? "graded" : "submitted", attachments: [], submission_comments: [] });
const message = (text: string) => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] });
const call = (name: string, args: unknown) => Response.json({ status: "completed", output: [{ type: "function_call", call_id: name, name, arguments: JSON.stringify(args) }] });

async function scenario(opts: GradeOptions, empty = false) {
  process.env.LLM_BASE_URL = "https://llm.test";
  process.env.LLM_API_KEY = "test-key";
  process.env.SKIP_GRADED_SUBMISSIONS = "true";
  process.env.SKIP_FULL_SCORE_COMMENT = "true";
  const dir = await fs.mkdtemp(path.join(tmpdir(), "grade-agent-test-"));
  let turn = 0, posted = 0;
  const graded: number[] = [];
  const subs = empty ? [submission(1)] : [submission(1), submission(2), submission(3)];
  const manager = new GradingBatchManager({ concurrency: 2, taskTimeoutMs: 1000, maxAttempts: 1 }, {
    outputDir: dir, log: () => {},
    loadAssignment: async (file) => { assert.equal(file, opts.assignmentFile); return { items: [{ id: "1", requirement: "答题" }] }; },
    getStudents: async () => subs.map((s) => ({ id: s.user_id, name: `学生${s.user_id}` })),
    getSubmissions: async (course, assignment) => { assert.equal(course, opts.course); assert.equal(assignment, opts.assignment); return subs; },
    runGrader: async (_batch, task) => {
      graded.push(task.userId);
      if (task.userId === 3) throw new Error("附件模糊");
      return { score: 10, maxScore: 10, baseScore: 10, latePenalty: 0, lateSeconds: 0, comment: "完成",
        items: [{ id: "1", status: "complete", reason: "完整", score: 10, maxScore: 10 }] };
    },
  });
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    if (url.hostname !== "llm.test") {
      if (request?.method === "POST") {
        const params = new URLSearchParams(await request.text());
        assert.ok(url.pathname.includes(`/courses/${opts.course}/assignments/${opts.assignment}/`));
        assert.equal(params.get("grade_data[2][posted_grade]"), "10");
        assert.equal(params.get("grade_data[2][text_comment]"), opts.includeFullScoreComment ? "完成" : null);
        assert.equal(params.has("grade_data[1][posted_grade]"), false);
        assert.equal(params.has("grade_data[3][posted_grade]"), false);
        posted++;
        return Response.json({});
      }
      return Response.json(url.searchParams.get("page") === "1" ? subs : []);
    }
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools.some((tool: any) => tool.name === "post-grades"), !opts.dryRun);
    assert.equal(body.tools.some((tool: any) => tool.name === "grade-all"), false);
    if (turn++ === 0) {
      assert.match(body.instructions, /Canvas LMS 自动评分助手/);
      assert.match(body.input[0].content, /使用 subagent/);
      // 模型传入的错误范围被固定命令参数覆盖，也不能缩小为部分学生。
      return call("prepare-grading-batch", { courseId: 999, assignmentId: 999, assignmentFile: "wrong.md", userIds: [2] });
    }
    const output = JSON.parse(body.input.at(-1).output);
    if (turn === 2) {
      const batch = JSON.parse(output.content[0].text);
      assert.deepEqual(batch.eligibleStudents.map((s: any) => s.userId), empty ? [] : [2, 3]);
      return call(empty ? "finalize-grading-batch" : "delegate-grading", { batchId: batch.batchId, ...(empty ? {} : { userIds: [2, 3] }) });
    }
    if (!empty && turn === 3) return call("finalize-grading-batch", { batchId: JSON.parse(output.content[0].text).batchId });
    if (turn === (empty ? 3 : 4)) {
      const summary = JSON.parse(output.content[0].text);
      assert.equal(summary.status, empty ? "completed" : "partial");
      // dry-run下即使模型尝试写回，也不能执行；非dry-run使用程序绑定的记录。
      return call("post-grades", { courseId: 999, assignmentId: 999, recordFile: "/wrong.json" });
    }
    if (opts.dryRun) assert.equal(output.isError, true);
    return message("已完成评分，成功与失败情况见记录。");
  };
  try {
    await runGradingAgent(opts, { batchManager: manager });
    assert.deepEqual(graded.sort(), empty ? [] : [2, 3]);
    assert.equal(posted, opts.dryRun || empty ? 0 : 1);
    const file = (await fs.readdir(dir)).find((name) => name.startsWith("grading_records_"))!;
    const records = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
    assert.deepEqual(records.map((r: any) => r.userId), empty ? [] : [2]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("CLI评分经主agent委派，dry-run在工具层禁用写回，保留跳过设置及部分成功记录", async () => {
  await scenario({ course: 95292, assignment: 429841, assignmentFile: "./作业1.md", dryRun: true });
});

test("CLI默认写回成功学生，满分评语选项继续有效", async () => {
  for (const includeFullScoreComment of [false, true]) await scenario({ course: 95292, assignment: 429841, assignmentFile: "./作业1.md", includeFullScoreComment });
});

test("CLI所有提交均跳过时仍保存空批次，不发送成绩", async () => {
  await scenario({ course: 95292, assignment: 429841, assignmentFile: "./作业1.md" }, true);
});

test("主agent未执行评分或耗尽轮数时CLI失败，不把模型口头完成当成成绩", async () => {
  process.env.LLM_BASE_URL = "https://llm.test";
  process.env.LLM_API_KEY = "test-key";
  globalThis.fetch = async () => message("评分完成，全部100分");
  await assert.rejects(runGradingAgent({ course: 1, assignment: 2, assignmentFile: "x", dryRun: true }), /评分汇总未完成/);
  let requests = 0;
  globalThis.fetch = async () => { requests++; return call("post-grades", {}); };
  await assert.rejects(runGradingAgent({ course: 1, assignment: 2, assignmentFile: "x", dryRun: true }), /最大工具循环轮数/);
  assert.equal(requests, 10);
});
