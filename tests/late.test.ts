import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SubmissionSchema } from "../src/api/types.js";
import { getLatePenalty } from "../src/grader/late.js";
import { gradeSubmission } from "../src/grader/grader.js";
import { toCanvasGrade } from "../src/grader/posting.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("迟交按实际时长分档，1、2、7、28天边界包含在较低扣分档", () => {
  for (const [seconds, penalty] of [
    [1, 10], [86400, 10], [86401, 20], [2 * 86400, 20],
    [2 * 86400 + 1, 30], [7 * 86400, 30], [7 * 86400 + 1, 40],
    [28 * 86400, 40], [28 * 86400 + 1, 50], [100 * 86400, 50],
  ]) {
    assert.deepEqual(getLatePenalty({ late: true, submitted_at: null, seconds_late: seconds }), {
      lateSeconds: seconds, latePenalty: penalty,
    });
  }
  assert.deepEqual(getLatePenalty({ late: false, submitted_at: null, seconds_late: 86400 }), { lateSeconds: 0, latePenalty: 0 });
});

test("保留Canvas时长字段，优先使用迟交秒数及学生截止时间，兼容作业截止时间", () => {
  const sub = SubmissionSchema.parse({ id: 1, user_id: 2, grade: null, score: null,
    late: true, workflow_state: "submitted", submitted_at: "2026-10-08T12:00:00+08:00",
    cached_due_date: "2026-10-07T04:00:00Z", seconds_late: 172801 });
  assert.equal(getLatePenalty(sub).latePenalty, 30);
  assert.equal(getLatePenalty({ ...sub, seconds_late: null, dueAt: "2026-10-01T00:00:00Z" }).latePenalty, 10);
  assert.equal(getLatePenalty({ ...sub, seconds_late: undefined, cached_due_date: undefined, dueAt: "2026-10-06T04:00:00Z" }).latePenalty, 20);
});

test("迟交数据缺失、无效或相互矛盾时阻止评分，避免默默给错分", async () => {
  globalThis.fetch = async () => { throw new Error("不应调用模型"); };
  for (const timing of [
    { late: true, submitted_at: null },
    { late: true, submitted_at: "invalid", dueAt: "2026-10-01T00:00:00Z" },
    { late: true, submitted_at: null, seconds_late: -1 },
    { late: true, submitted_at: null, seconds_late: 0 },
    { late: true, submitted_at: null, seconds_late: Infinity },
  ]) {
    await assert.rejects(gradeSubmission("提交", { items: [{ id: "1", requirement: "解答" }] }, timing), /无法确定有效迟交时长/);
  }
});

test("迟交从题目总分扣除，明细不变，最终分数及扣分评语用于Canvas写回", async () => {
  process.env.LLM_BASE_URL = "https://example.test/v1";
  process.env.LLM_API_KEY = "test-key";
  const items = Array.from({ length: 13 }, (_, i) => ({ id: String(i), requirement: "完成解答" }));
  globalThis.fetch = async () => Response.json({ status: "completed", output: [{ type: "message", content: [{
    type: "output_text", text: JSON.stringify({ items: items.map(({ id }) => ({ id, status: "complete", reason: "已完成" })), comment: "全部完成" }),
  }] }] });
  const grade = await gradeSubmission("解答", { items }, { late: true, submitted_at: null, seconds_late: 86400 });
  assert.equal(grade.baseScore, 130);
  assert.equal(grade.score, 120);
  assert.equal(grade.maxScore, 130);
  assert.equal(grade.items.reduce((sum, item) => sum + item.score, 0), 130);
  assert.match(grade.comment, /扣10分/);
  assert.deepEqual(toCanvasGrade(grade, true), { posted_grade: 120, text_comment: grade.comment });
});
