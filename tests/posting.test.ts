import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { toCanvasGrade } from "../src/grader/posting.js";

process.env.CANVAS_BASE_URL = "https://canvas.example.test";
process.env.CANVAS_TOKEN = "test-token";
const { postGrades } = await import("../src/api/canvas.js");
const originalFetch = globalThis.fetch;
const originalSetting = process.env.SKIP_FULL_SCORE_COMMENT;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSetting === undefined) delete process.env.SKIP_FULL_SCORE_COMMENT;
  else process.env.SKIP_FULL_SCORE_COMMENT = originalSetting;
});

test("默认满分不发评语，扣分发送评语；适用于130分作业和缺少满分的旧记录", async () => {
  delete process.env.SKIP_FULL_SCORE_COMMENT;
  const full = { score: 130, maxScore: 130, comment: "完整" };
  const deducted = { score: 120, maxScore: 130, comment: "第3题缺失" };
  const legacy = { score: 100, comment: "旧记录" };
  globalThis.fetch = async (input) => {
    const request = input as Request;
    assert.equal(request.method, "POST");
    const body = new URLSearchParams(await request.text());
    assert.equal(body.get("grade_data[1][posted_grade]"), "130");
    assert.equal(body.has("grade_data[1][text_comment]"), false);
    assert.equal(body.get("grade_data[2][text_comment]"), "第3题缺失");
    assert.equal(body.get("grade_data[3][text_comment]"), "旧记录");
    return Response.json({});
  };
  await postGrades(1, 2, { 1: toCanvasGrade(full), 2: toCanvasGrade(deducted), 3: toCanvasGrade(legacy) });
  assert.equal(full.comment, "完整");
});

test("环境设置和调用参数可以恢复满分评语；扣分评语始终保留", () => {
  const full = { score: 10, maxScore: 10, comment: "完整" };
  process.env.SKIP_FULL_SCORE_COMMENT = "false";
  assert.deepEqual(toCanvasGrade(full), { posted_grade: 10, text_comment: "完整" });
  assert.deepEqual(toCanvasGrade(full, true), { posted_grade: 10 });
  process.env.SKIP_FULL_SCORE_COMMENT = "true";
  assert.deepEqual(toCanvasGrade(full, false), { posted_grade: 10, text_comment: "完整" });
  assert.deepEqual(toCanvasGrade({ ...full, score: 0 }, true), { posted_grade: 0, text_comment: "完整" });
});
