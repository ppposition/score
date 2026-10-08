import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createResponse } from "../src/api/llm.js";
import { chat } from "../src/agent/llm.js";
import { gradeSubmission } from "../src/grader/grader.js";

process.env.LLM_BASE_URL = "https://example.test/api/v1/";
process.env.LLM_API_KEY = "test-key";
process.env.LLM_MODEL = "glm-5.3-flash";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function completed(output: unknown[]) {
  return Response.json({ status: "completed", output });
}

test("Responses 工具调用保留推理，并通过 call_id 关联下一轮工具结果", async () => {
  const reasoning = { type: "reasoning", content: [{ type: "reasoning_text", text: "需要查课程" }], summary: [] };
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `${process.env.LLM_BASE_URL!.replace(/\/+$/, "")}/responses`);
    const body = JSON.parse(String(init!.body));
    assert.equal(body.model, "glm-5.3-flash");
    assert.equal(body.store, false);
    assert.equal(body.tools[0].type, "function");
    assert.equal(typeof body.tools[0].name, "string");
    assert.equal(body.tools[0].function, undefined);
    if (requests++ === 0) {
      return completed([reasoning, { type: "function_call", id: "fc_1", call_id: "call_1", name: "list_courses", arguments: "{}" }]);
    }
    assert.deepEqual(body.input.slice(1), [
      reasoning,
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "list_courses", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "示例课程" },
    ]);
    return completed([reasoning, { type: "message", content: [{ type: "output_text", text: "找到示例课程" }] }]);
  };
  const user = { role: "user" as const, content: "列出课程" };
  const first = await chat([user]);
  assert.equal(first.tool_calls![0].id, "call_1");
  assert.equal(first.content, null);
  const second = await chat([user, first, { role: "tool", tool_call_id: "call_1", content: "示例课程" }]);
  assert.equal(second.content, "找到示例课程");
});

test("评分只读取最终 JSON，不读取思维链", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    assert.deepEqual(body.text, { format: { type: "json_object" } });
    assert.match(body.input, /示例提交/);
    return completed([
      { type: "reasoning", content: [{ type: "reasoning_text", text: '{"score":0,"comment":"中间思考"}' }] },
      { type: "message", content: [{ type: "output_text", text: '{"items":[{"id":"1","status":"complete","reason":"已完整作答"}],"comment":"作答完整"}' }] },
    ]);
  };
  const result = await gradeSubmission("示例提交", { items: [{ id: "1", requirement: "示例要求" }] });
  assert.equal(result.score, 10);
  assert.equal(result.maxScore, 10);
  assert.equal(result.comment, "作答完整");
});

test("API 错误和截断响应抛出错误", async () => {
  globalThis.fetch = async () => Response.json({ error: { message: "No permission" } }, { status: 403 });
  await assert.rejects(createResponse({ input: "test" }), /HTTP 403.*No permission/);
  globalThis.fetch = async () => Response.json({ status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } });
  await assert.rejects(createResponse({ input: "test" }), /max_output_tokens/);
  globalThis.fetch = async () => new Response("Bad gateway", { status: 502 });
  await assert.rejects(createResponse({ input: "test" }), /非 JSON.*HTTP 502/);
});

test("无效评分不会被当成零分", async () => {
  for (const text of ["invalid", '{"score":101,"comment":"越界"}', '{"score":90}']) {
    globalThis.fetch = async () => completed([{ type: "message", content: [{ type: "output_text", text }] }]);
    await assert.rejects(gradeSubmission("示例提交", { items: [{ id: "1", requirement: "示例要求" }] }));
  }
});
