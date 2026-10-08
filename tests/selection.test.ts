import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { shouldSkipSubmission } from "../src/grader/selection.js";

process.env.CANVAS_BASE_URL = "https://canvas.example.test";
process.env.CANVAS_TOKEN = "test-token";
process.env.LLM_BASE_URL = "https://llm.example.test/v1";
process.env.LLM_API_KEY = "test-key";
const { gradeAll, gradeSingle, postGradesTool } = await import("../src/agent/tools/grading.js");
const originalFetch = globalThis.fetch;
const originalSetting = process.env.SKIP_GRADED_SUBMISSIONS;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSetting === undefined) delete process.env.SKIP_GRADED_SUBMISSIONS;
  else process.env.SKIP_GRADED_SUBMISSIONS = originalSetting;
});

test("默认允许重评，开启后跳过已评分状态，重新提交仍评分", () => {
  delete process.env.SKIP_GRADED_SUBMISSIONS;
  assert.equal(shouldSkipSubmission({ workflow_state: "graded" }), false);
  process.env.SKIP_GRADED_SUBMISSIONS = "false";
  assert.equal(shouldSkipSubmission({ workflow_state: "graded" }), false);
  process.env.SKIP_GRADED_SUBMISSIONS = " TRUE ";
  assert.equal(shouldSkipSubmission({ workflow_state: "graded" }), true);
  assert.equal(shouldSkipSubmission({ workflow_state: "submitted" }), false);
});

test("跳过已评分的0分提交，不下载其附件；新记录按学生ID写回，兼容旧记录", async () => {
  process.env.SKIP_GRADED_SUBMISSIONS = "true";
  const dir = await fs.mkdtemp(path.join(tmpdir(), "skip-grading-"));
  const assignmentFile = path.join(dir, "题目.md");
  await fs.writeFile(assignmentFile, "# 第1题\n完成解答");
  const recordFile = path.join(dir, "records.json");
  let outputFile: string | undefined;
  let downloads = 0;
  const posted: URLSearchParams[] = [];
  const submissions = [
    { id: 1, user_id: 1, grade: "0", score: 0, submitted_at: "2026-10-08", late: false, workflow_state: "graded", attachments: [] },
    { id: 2, user_id: 2, grade: "0", score: 0, submitted_at: "2026-10-08", late: false, workflow_state: "submitted", attachments: [
      { id: 2, filename: "answer.md", display_name: "answer.md", size: 10, "content-type": "text/markdown", url: "https://attachment.test/2" },
    ] },
  ];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    if (url.hostname === "attachment.test") {
      downloads++;
      return new Response("学生2的完整解答");
    }
    if (url.hostname === "llm.example.test") {
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
        items: [{ id: "第1题", status: "complete", reason: "完整" }], comment: "已完成",
      }) }] }] });
    }
    if ((request?.method ?? init?.method) === "POST") {
      posted.push(new URLSearchParams(await request!.text()));
      return Response.json({});
    }
    if (url.searchParams.get("page") === "2") return Response.json([]);
    if (url.pathname.endsWith("/submissions")) return Response.json(submissions);
    if (url.pathname.endsWith("/users")) return Response.json([{ id: 1, name: "学生1" }, { id: 2, name: "学生2" }]);
    throw new Error(`意外请求：${url}`);
  };
  try {
    const args = { courseId: 1, assignmentId: 2, assignmentFile };
    assert.match((await gradeSingle.handler({ ...args, userId: 1 })).content[0].text, /跳过/);
    assert.equal(downloads, 0);
    const result = await gradeAll.handler({ ...args, dryRun: true });
    assert.match(result.content[0].text, /跳过 \[1\]/);
    outputFile = result.content[0].text.match(/评分记录已保存: (.+)/)?.[1];
    assert.ok(outputFile);
    const records = JSON.parse(await fs.readFile(outputFile, "utf-8"));
    assert.deepEqual(records.map((r: { userId: number }) => r.userId), [2]);
    assert.equal(downloads, 1);
    assert.equal(posted.length, 0);
    await postGradesTool.handler({ ...args, recordFile: outputFile });
    assert.equal(posted[0].get("grade_data[2][posted_grade]"), "10");
    assert.equal(posted[0].has("grade_data[1][posted_grade]"), false);

    process.env.SKIP_GRADED_SUBMISSIONS = "false";
    await fs.writeFile(recordFile, JSON.stringify([{ ...records[0], userId: 2, score: 8 }, { ...records[0], userId: 1, score: 6 }]));
    await postGradesTool.handler({ ...args, recordFile });
    assert.equal(posted[1].get("grade_data[1][posted_grade]"), "6");
    assert.equal(posted[1].get("grade_data[2][posted_grade]"), "8");

    process.env.SKIP_GRADED_SUBMISSIONS = "true";
    const { userId, ...legacy } = records[0];
    await fs.writeFile(recordFile, JSON.stringify([{ ...legacy, score: 0 }, legacy]));
    await postGradesTool.handler({ ...args, recordFile });
    assert.equal(posted[2].get("grade_data[2][posted_grade]"), "10");
    assert.equal(posted[2].has("grade_data[1][posted_grade]"), false);
    await fs.writeFile(recordFile, JSON.stringify([{ ...legacy, userId: 1 }]));
    assert.match((await postGradesTool.handler({ ...args, recordFile })).content[0].text, /已写回 0/);
    assert.equal(posted.length, 3);
  } finally {
    if (outputFile) await fs.rm(outputFile, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});
