import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { GradingBatchManager, readSubagentSettings } from "../src/agent/subagents/manager.js";
import { runGrader } from "../src/agent/subagents/grader.js";
import { RequestError } from "../src/api/errors.js";
import { getLatePenalty } from "../src/grader/late.js";
import { prepareAttachments } from "../src/grader/attachments.js";
import { postGradesTool } from "../src/agent/tools/grading.js";
import { prepareGradingBatch, delegateGrading, finalizeGradingBatch } from "../src/agent/tools/delegation.js";
import type { GradingBatch, GradingTask } from "../src/agent/subagents/types.js";
import type { Submission } from "../src/api/types.js";
import type { GradeResult } from "../src/grader/grader.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const directories: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const rubric = { items: [{ id: "1", requirement: "完成步骤" }, { id: "2", requirement: "完成证明" }] };
const submission = (id: number): Submission => ({ id, user_id: id, grade: null, score: null, late: false,
  submitted_at: "2026-10-01T00:00:00Z", workflow_state: "submitted", submission_comments: [],
  attachments: [{ id, filename: `${id}.md`, display_name: `${id}.md`, url: `https://attachment.test/${id}`, "content-type": "text/markdown", size: 1 }] });
function grade(batch: GradingBatch, task: GradingTask): GradeResult {
  const late = getLatePenalty({ ...batch.submissions.get(task.userId)!, dueAt: batch.dueAt });
  return { score: Math.max(0, 20 - late.latePenalty), baseScore: 20, maxScore: 20, ...late, comment: "已完成",
    items: rubric.items.map(({ id }) => ({ id, status: "complete", reason: "完整作答", score: 10, maxScore: 10 })) };
}
async function manager(subs: Submission[], executor: typeof runGrader = async (batch, task) => grade(batch, task), concurrency = 2, attempts = 2, timeout = 1000) {
  process.env.SKIP_GRADED_SUBMISSIONS = "false";
  const dir = await fs.mkdtemp(path.join(tmpdir(), "subagents-test-"));
  directories.push(dir);
  const logs: string[] = [];
  const waits: number[] = [];
  const service = new GradingBatchManager({ concurrency, maxAttempts: attempts, taskTimeoutMs: timeout }, {
    outputDir: dir, log: (line) => { logs.push(line); }, loadAssignment: async () => rubric,
    getStudents: async () => subs.map((sub) => ({ id: sub.user_id, name: `学生${sub.user_id}` })),
    getSubmissions: async () => subs, runGrader: executor,
    wait: async (ms) => { waits.push(ms); },
    getAssignment: async () => ({ id: 2, name: "作业", description: null, due_at: "2026-09-30T00:00:00Z", points_possible: 20 }),
  });
  return { service, dir, logs, waits };
}
const prepare = (service: GradingBatchManager, userIds?: number[]) => service.prepare({ courseId: 1, assignmentId: 2, assignmentFile: "assignment.md", ...(userIds ? { userIds } : {}) });

test("跨批次受限并发、三个独立taskId重叠，重复委派复用在途及成功任务", async () => {
  let active = 0, peak = 0, calls = 0;
  const taskIds = new Set<string>();
  const { service, logs } = await manager([submission(1), submission(2), submission(3)], async (batch, task) => {
    calls++; active++; peak = Math.max(peak, active); taskIds.add(task.taskId);
    await delay(25);
    active--;
    return grade(batch, task);
  });
  const a = await prepare(service, [1, 2]);
  const b = await prepare(service, [3]);
  await Promise.all([
    service.delegate({ batchId: a.batchId, userIds: [1, 2] }),
    service.delegate({ batchId: b.batchId, userIds: [3] }),
    service.delegate({ batchId: a.batchId, userIds: [1] }),
  ]);
  assert.equal(peak, 2);
  assert.equal(calls, 3);
  assert.equal(taskIds.size, 3);
  await service.delegate({ batchId: a.batchId, userIds: [1, 2], retryFailed: true });
  assert.equal(calls, 3);
  assert.match(logs[0], /prepared/);
  assert.ok(logs.some((line) => /elapsedMs=/.test(line)));
});

test("校验全部ID后才能启动；pending和running阻止汇总及清空", async () => {
  let calls = 0;
  const { service, dir } = await manager([submission(1), submission(2)], async (batch, task) => {
    calls++; await delay(25); return grade(batch, task);
  });
  const batch = await prepare(service);
  await assert.rejects(service.delegate({ batchId: batch.batchId, userIds: [1, 99] }), /99/);
  await assert.rejects(service.delegate({ batchId: batch.batchId, userIds: [1, 1] }));
  assert.equal(calls, 0);
  await assert.rejects(service.finalize({ batchId: batch.batchId }), /1, 2/);
  assert.deepEqual(await fs.readdir(dir), []);
  const pending = service.delegate({ batchId: batch.batchId, userIds: [1, 2] });
  await delay(5);
  assert.throws(() => service.clear(), /在途/);
  await assert.rejects(service.finalize({ batchId: batch.batchId }), /未完成/);
  await pending;
  service.clear();
  await assert.rejects(service.finalize({ batchId: batch.batchId }), /不存在/);
});

test("一个失败保留其他成绩，partial文件兼容post-grades，迟交只扣一次，重复汇总保持路径", async () => {
  const subs = [submission(1), { ...submission(2), late: true, seconds_late: 86400 }, submission(3)];
  const { service, dir } = await manager(subs, async (batch, task) => {
    if (task.userId === 3) throw new Error("附件无法辨认 runtime-key");
    return grade(batch, task);
  });
  process.env.LLM_API_KEY = "runtime-key";
  const batch = await prepare(service);
  const result = await service.delegate({ batchId: batch.batchId, userIds: [1, 2, 3] });
  assert.deepEqual(result.progress, { pending: 0, running: 0, succeeded: 2, failed: 1 });
  const summary = await service.finalize({ batchId: batch.batchId });
  assert.equal(summary.status, "partial");
  const records = JSON.parse(await fs.readFile(summary.recordFile, "utf8"));
  assert.deepEqual(records.map((r: any) => [r.userId, r.score]), [[1, 20], [2, 10]]);
  const manifest = JSON.parse(await fs.readFile(summary.manifestFile, "utf8"));
  assert.equal(manifest.tasks[2].result, undefined);
  assert.equal(manifest.tasks[2].error.message.includes("runtime-key"), false);
  const stat = await fs.stat(summary.recordFile);
  assert.deepEqual(await service.finalize({ batchId: batch.batchId }), summary);
  assert.equal((await fs.stat(summary.recordFile)).mtimeMs, stat.mtimeMs);
  assert.equal((await fs.readdir(dir)).length, 2);
  let posted = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST" || (url instanceof Request && url.method === "POST")) {
      const body = url instanceof Request ? await url.text() : String(init?.body);
      const params = new URLSearchParams(body);
      assert.equal(params.get("grade_data[1][posted_grade]"), "20");
      assert.equal(params.get("grade_data[1][text_comment]"), null);
      assert.equal(params.get("grade_data[2][posted_grade]"), "10");
      assert.equal(params.get("grade_data[2][text_comment]"), "已完成");
      assert.equal(params.get("grade_data[3][posted_grade]"), null);
      posted++;
      return Response.json({});
    }
    const request = url instanceof Request ? url.url : String(url);
    return Response.json(new URL(request).searchParams.get("page") === "1" ? [subs[2], subs[1], subs[0]] : []);
  };
  process.env.SKIP_FULL_SCORE_COMMENT = "true";
  await postGradesTool.handler({ courseId: 1, assignmentId: 2, recordFile: summary.recordFile });
  assert.equal(posted, 1);
});

test("网络/429/5xx重试受限且遵守Retry-After，401和无效成绩不重试；显式重试共用次数", async () => {
  let succeed = false;
  const { service, waits } = await manager([submission(1), submission(2)], async (batch, task) => {
    if (task.userId === 2) throw new RequestError("HTTP_401", "unauthorized");
    if (!succeed) throw new RequestError("HTTP_429", "rate limited", true, 1500);
    return grade(batch, task);
  }, 2, 3);
  const batch = await prepare(service);
  const first = await service.delegate({ batchId: batch.batchId, userIds: [1, 2] });
  assert.deepEqual(first.results.map((r) => r.attempts), [2, 1]);
  assert.deepEqual(waits, [1500]);
  const failed = await service.finalize({ batchId: batch.batchId });
  assert.equal(failed.status, "failed");
  assert.deepEqual(JSON.parse(await fs.readFile(failed.recordFile, "utf8")), []);
  assert.equal((await service.delegate({ batchId: batch.batchId, userIds: [1] })).results[0].attempts, 2);
  succeed = true;
  const retry = await service.delegate({ batchId: batch.batchId, userIds: [1, 2], retryFailed: true });
  assert.deepEqual(retry.results.map((r) => r.attempts), [3, 1]);
  assert.equal(retry.results[0].taskId, first.results[0].taskId);
  const final = await service.finalize({ batchId: batch.batchId });
  assert.equal(final.status, "partial");
  assert.equal(final.recordFile, failed.recordFile);
  assert.equal(JSON.parse(await fs.readFile(final.recordFile, "utf8")).length, 1);
});

test("结果缺题、重复、unreadable、非有限分数和错误迟交数据不能保存成功", async () => {
  for (const corrupt of [
    (r: GradeResult) => ({ ...r, items: r.items.slice(1) }),
    (r: GradeResult) => ({ ...r, items: [r.items[0], r.items[0]] }),
    (r: GradeResult) => ({ ...r, items: [{ ...r.items[0], status: "unreadable" }, r.items[1]] }),
    (r: GradeResult) => ({ ...r, score: Infinity }),
    (r: GradeResult) => ({ ...r, latePenalty: 10 }),
  ]) {
    const { service } = await manager([submission(1)], async (batch, task) => corrupt(grade(batch, task)) as GradeResult);
    const batch = await prepare(service);
    const result = await service.delegate({ batchId: batch.batchId, userIds: [1] });
    assert.equal(result.results[0].status, "failed");
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.results[0].score, undefined);
  }
});

test("准备快照不受源对象修改影响；跳过、截止补取、非法范围和空批次", async () => {
  const subs = [{ ...submission(1), late: true }, { ...submission(2), workflow_state: "graded" }, { ...submission(3), workflow_state: "unsubmitted" }];
  const { service } = await manager(subs);
  process.env.SKIP_GRADED_SUBMISSIONS = "true";
  const batch = await prepare(service);
  assert.deepEqual(batch.eligibleStudents.map((s) => s.userId), [1]);
  assert.equal(batch.skipped.length, 2);
  subs[0].submitted_at = "bad timestamp";
  assert.equal((await service.delegate({ batchId: batch.batchId, userIds: [1] })).results[0].score, 10);
  await assert.rejects(prepare(service, [999]), /999/);
  await assert.rejects(prepare(service, [1]), /迟交/);
  const empty = await prepare(service, [2, 3]);
  const summary = await service.finalize({ batchId: empty.batchId });
  assert.equal(summary.status, "completed");
  assert.equal(summary.skipped.length, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(summary.recordFile, "utf8")), []);
});

test("子agent外层只收到绑定任务和限定工具，重复评分调用复用Promise，成功无总结请求", async () => {
  process.env.LLM_BASE_URL = "https://llm.test";
  process.env.LLM_API_KEY = "test-key";
  let routes = 0, grading = 0, downloads = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://attachment.test")) { downloads++; return new Response("当前学生独立解答"); }
    const body = JSON.parse(String(init?.body));
    if (body.tools) {
      routes++;
      assert.deepEqual(body.tools.map((tool: any) => tool.name), ["grade-assigned-submission"]);
      assert.equal(body.input.length, 1);
      assert.equal(body.input[0].content.includes("解答"), false);
      return Response.json({ status: "completed", output: ["first", "second"].map((id) => ({ type: "function_call", call_id: id, name: "grade-assigned-submission", arguments: "{}" })) });
    }
    grading++;
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ items: rubric.items.map(({ id }) => ({ id, status: "complete", reason: "完整" })), comment: "完成" }) }] }] });
  };
  const { service } = await manager([submission(1)], runGrader);
  const batch = await prepare(service);
  assert.equal((await service.delegate({ batchId: batch.batchId, userIds: [1] })).results[0].score, 20);
  assert.deepEqual([routes, grading, downloads], [1, 1, 1]);
});

test("子agent直接报分、未知工具、评分工具失败不会生成成绩", async () => {
  process.env.LLM_BASE_URL = "https://llm.test";
  process.env.LLM_API_KEY = "test-key";
  for (const output of [
    [{ type: "message", content: [{ type: "output_text", text: "100分" }] }],
    [{ type: "function_call", call_id: "one", name: "post-grades", arguments: "{}" }],
    [{ type: "function_call", call_id: "one", name: "grade-assigned-submission", arguments: "{}" }],
  ]) {
    globalThis.fetch = async (url) => String(url).startsWith("https://attachment.test") ? new Response("denied", { status: 403 }) : Response.json({ status: "completed", output });
    const { service } = await manager([submission(1)], runGrader);
    const batch = await prepare(service);
    const result = await service.delegate({ batchId: batch.batchId, userIds: [1] });
    assert.equal(result.results[0].status, "failed");
    assert.equal(result.results[0].score, undefined);
    assert.equal(result.results[0].attempts, 1);
  }
});

test("任务超时取消fetch，清理完成才释放slot；排队时间不计超时，迟到成绩不生效", async () => {
  let active = 0, peak = 0, cleaned = false;
  const { service } = await manager([submission(1), submission(2)], async (batch, task, signal) => {
    active++; peak = Math.max(peak, active);
    if (task.userId === 1) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { void delay(15).then(resolve); }, { once: true }));
      cleaned = true; active--;
      return grade(batch, task); // 故意模拟清理后的迟到结果。
    }
    assert.ok(cleaned);
    await delay(5); active--;
    return grade(batch, task);
  }, 1, 1, 20);
  const batch = await prepare(service);
  const result = await service.delegate({ batchId: batch.batchId, userIds: [1, 2] });
  assert.equal(peak, 1);
  assert.equal(result.results[0].error?.code, "TIMEOUT");
  assert.equal(result.results[0].score, undefined);
  assert.equal(result.results[1].status, "succeeded");
  let cancelled = false;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => { cancelled = true; reject(init!.signal!.reason); }, { once: true }));
  const controller = new AbortController();
  const download = prepareAttachments(submission(1).attachments, controller.signal);
  controller.abort();
  await assert.rejects(download, (error: any) => error.code === "CANCELLED");
  assert.ok(cancelled);
});

test("工具handler严格校验参数，未知批次、非整数、额外权限和无服务返回isError", async () => {
  const { service } = await manager([submission(1)]);
  for (const [tool, args] of [
    [prepareGradingBatch, { courseId: 1.5, assignmentId: 2, assignmentFile: "x" }],
    [prepareGradingBatch, { courseId: 1, assignmentId: 2, assignmentFile: "x", model: "other" }],
    [delegateGrading, { batchId: "bad", userIds: [1] }],
    [finalizeGradingBatch, { batchId: "00000000-0000-4000-8000-000000000000" }],
  ] as const) assert.equal((await tool.handler(args, { batchManager: service })).isError, true);
  assert.equal((await prepareGradingBatch.handler({})).isError, true);
});

test("启动配置严格验证并发、超时和总尝试次数", () => {
  for (const [key, values] of Object.entries({ SUBAGENT_MAX_CONCURRENCY: ["0", "9", "1.5"], SUBAGENT_TASK_TIMEOUT_MS: ["0", "bad"], SUBAGENT_MAX_ATTEMPTS: ["0", "4"], LLM_REQUEST_TIMEOUT_MS: ["-1", ""] })) {
    const previous = process.env[key];
    for (const value of values) { process.env[key] = value; assert.throws(readSubagentSettings, new RegExp(key)); }
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test("PDF取消后pdfinfo和pdftoppm进程已退出，临时目录已清理", async () => {
  process.env.LLM_VISION_MODEL = "mock-vision";
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pdf-cancel-test-"));
  directories.push(dir);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  globalThis.fetch = async () => new Response("%PDF-test");
  for (const executable of ["pdfinfo", "pdftoppm"]) {
    const marker = path.join(dir, `${executable}.json`);
    const slow = `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, input: process.argv.includes('-jpegopt') ? process.argv[process.argv.indexOf('-jpegopt') + 2] : process.argv[2] }));\nsetInterval(() => {}, 1000);\n`;
    await fs.writeFile(path.join(dir, "pdfinfo"), executable === "pdfinfo" ? slow : `#!${process.execPath}\nconsole.log('Pages: 1');\n`, { mode: 0o755 });
    await fs.writeFile(path.join(dir, "pdftoppm"), slow, { mode: 0o755 });
    const controller = new AbortController();
    const pending = prepareAttachments([{ ...submission(1).attachments[0], filename: "scan.pdf", "content-type": "application/pdf" }], controller.signal);
    // 等待实际子进程启动，再取消；不依赖转换快慢。
    let info: { pid: number; input: string } | undefined;
    try {
      for (let i = 0; i < 200; i++) {
        try { info = JSON.parse(await fs.readFile(marker, "utf8")); break; } catch { await delay(5); }
      }
      assert.ok(info, `${executable} 未启动`);
    } finally { controller.abort(); }
    await assert.rejects(pending, (error: any) => error.code === "CANCELLED");
    assert.throws(() => process.kill(info!.pid, 0), (error: any) => error.code === "ESRCH");
    await assert.rejects(fs.access(path.dirname(info!.input)), (error: any) => error.code === "ENOENT");
  }
});

test("四名学生完整prepare→delegate→finalize主agent流程：重叠评分、503恢复、失败清单与本地记录", async () => {
  const { runAgentLoop } = await import("../src/agent/runtime.js");
  const { loadAssignment } = await import("../src/grader/grader.js");
  const { AGENT_SYSTEM_PROMPT } = await import("../src/agent/llm.js");
  process.env.LLM_BASE_URL = "https://llm.test";
  process.env.LLM_API_KEY = "test-key";
  process.env.SKIP_GRADED_SUBMISSIONS = "false";
  const dir = await fs.mkdtemp(path.join(tmpdir(), "subagent-flow-"));
  directories.push(dir);
  const assignmentFile = path.join(dir, "assignment.md");
  await fs.writeFile(assignmentFile, "# 第1章\n## 第1题\n完成步骤\n## 第2题\n完成证明\n");
  const subs = [submission(1), { ...submission(2), late: true, seconds_late: 86400 }, submission(3), submission(4)];
  let mainTurns = 0, active = 0, peak = 0;
  const attempts = new Map<number, number>();
  const calls = (name: string, args: unknown) => Response.json({ status: "completed", output: [{ type: "function_call", call_id: `call-${mainTurns}`, name, arguments: JSON.stringify(args) }] });
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://attachment.test")) return new Response(`学生${String(url).split("/").at(-1)}解答`);
    const body = JSON.parse(String(init?.body));
    if (body.instructions === AGENT_SYSTEM_PROMPT) {
      mainTurns++;
      if (mainTurns === 1) return calls("prepare-grading-batch", { courseId: 1, assignmentId: 2, assignmentFile });
      const output = JSON.parse(body.input.at(-1).output);
      assert.equal(output.isError, undefined);
      const prior = JSON.parse(output.content[0].text);
      if (mainTurns === 2) return calls("delegate-grading", { batchId: prior.batchId, userIds: prior.eligibleStudents.map((s: any) => s.userId) });
      if (mainTurns === 3) {
        assert.deepEqual(prior.progress, { pending: 0, running: 0, succeeded: 3, failed: 1 });
        return calls("finalize-grading-batch", { batchId: prior.batchId });
      }
      assert.equal(prior.status, "partial");
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: `3人成功，1人失败，记录：${prior.recordFile}` }] }] });
    }
    if (body.tools) return calls("grade-assigned-submission", {});
    const content = body.input[0].content;
    const id = Number(content.find((part: any) => /学生\d解答/.test(part.text))!.text.match(/学生(\d)解答/)[1]);
    const count = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, count);
    active++; peak = Math.max(peak, active);
    await delay(10);
    active--;
    if (id === 4 && count === 1) return new Response("temporary gateway error", { status: 503, headers: { "Retry-After": "0" } });
    const scoringRubric = JSON.parse(content[0].text.match(/\[\{.*\}\]/)[0]);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ items: scoringRubric.map((item: any) => ({ id: item.id, status: id === 3 ? "unreadable" : "complete", reason: id === 3 ? "扫描模糊" : "完整" })), comment: "完成" }) }] }] });
  };
  const service = new GradingBatchManager({ concurrency: 3, taskTimeoutMs: 2000, maxAttempts: 2 }, {
    outputDir: dir, log: () => {}, loadAssignment, getSubmissions: async () => subs,
    getStudents: async () => subs.map((s) => ({ id: s.user_id, name: `学生${s.user_id}` })),
  });
  const run = await runAgentLoop([{ role: "user", content: "使用subagent并行评分，先保存，不写回Canvas" }], {
    name: "main", instructions: AGENT_SYSTEM_PROMPT, tools: [prepareGradingBatch, delegateGrading, finalizeGradingBatch], maxTurns: 10,
  }, { batchManager: service });
  assert.equal(run.status, "completed");
  assert.match(run.finalText!, /3人成功，1人失败/);
  assert.equal(peak, 3);
  assert.equal(attempts.get(4), 2);
  assert.equal(attempts.get(3), 1);
  const files = await fs.readdir(dir);
  const records = JSON.parse(await fs.readFile(path.join(dir, files.find((f) => f.startsWith("grading_records_"))!), "utf8"));
  assert.deepEqual(records.map((r: any) => [r.userId, r.score]), [[1, 20], [2, 10], [4, 20]]);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, files.find((f) => f.startsWith("grading_batch_"))!), "utf8"));
  assert.equal(new Set(manifest.tasks.map((t: any) => t.taskId)).size, 4);
  assert.equal(manifest.tasks[2].status, "failed");
});
