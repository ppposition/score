import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runAgentLoop } from "../src/agent/runtime.js";
import { createResponse } from "../src/api/llm.js";
import type { AgentRunConfig, Tool } from "../src/agent/types.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
const call = (name: string, id = "one", args = "{}") => ({ type: "function_call", call_id: id, name, arguments: args });
const response = (output: unknown[]) => Response.json({ status: "completed", output });
function config(tool: Tool, stop = false): AgentRunConfig {
  process.env.LLM_BASE_URL = "https://mock.test";
  process.env.LLM_API_KEY = "runtime-key";
  return { name: "test", instructions: "test instructions", tools: [tool], maxTurns: 2, ...(stop ? { stopAfterTools: [tool.name] } : {}) };
}
const ok: Tool = { name: "test", description: "test", parameters: { type: "object" }, handler: async () => ({ content: [{ type: "text", text: "ok" }] }) };

test("runtime只发送指定工具，顺序执行并补全所有call_id，成功工具直接结束", async () => {
  const seen: string[] = [];
  let requests = 0;
  const tool = { ...ok, handler: async (args: Record<string, unknown>) => {
    assert.equal(args.courseId, undefined);
    assert.equal(args.assignmentId, undefined);
    seen.push(String(args.value));
    return { content: [{ type: "text" as const, text: "ok" }] };
  } };
  const options = config(tool, true);
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.instructions, "test instructions");
    assert.deepEqual(body.tools.map((tool: any) => tool.name), ["test"]);
    return response([call("test", "one", '{"value":1}'), call("test", "two", '{"value":2}')]);
  };
  const result = await runAgentLoop([{ role: "user", content: "run" }], options, { currentCourseId: 12, currentAssignmentId: 34 });
  assert.equal(result.status, "completed");
  assert.equal(requests, 1);
  assert.deepEqual(seen, ["1", "2"]);
  assert.deepEqual(result.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), ["one", "two"]);
});

test("无效JSON、非对象、未知工具和isError不能触发成功停止", async () => {
  for (const [tool, output] of [
    [ok, [call("test", "one", "invalid"), call("test", "two")]],
    [ok, [call("test", "one", "[]")]],
    [ok, [call("post-grades")]],
    [{ ...ok, handler: async () => ({ content: [{ type: "text", text: "failure" }], isError: true }) }, [call("test")]],
  ] as [Tool, unknown[]][]) {
    const options = config(tool, true);
    globalThis.fetch = async () => response(output);
    const result = await runAgentLoop([], options, {});
    assert.equal(result.status, "failed");
    assert.equal(result.messages.filter((m) => m.role === "tool").length, output.length);
    assert.ok(result.messages.filter((m) => m.role === "tool").every((m) => JSON.parse(m.content!).isError));
  }
});

test("子agent自然语言成绩失败；主agent耗尽轮数返回max_turns", async () => {
  const options = config(ok, true);
  globalThis.fetch = async () => response([{ type: "message", content: [{ type: "output_text", text: "100分" }] }]);
  assert.equal((await runAgentLoop([], options, {})).error?.code, "REQUIRED_TOOL_NOT_CALLED");
  globalThis.fetch = async () => response([call("test")]);
  assert.equal((await runAgentLoop([], config(ok), {})).status, "max_turns");
});

test("主agent保留课程默认值，子agent不注入；工具失败保留isError供下一轮读取", async () => {
  let requests = 0;
  const options = config({ ...ok, parameters: { type: "object", properties: { courseId: { type: "number" } } }, handler: async (args) => {
    assert.equal(args.courseId, 12);
    return { content: [{ type: "text", text: "failed" }], isError: true };
  } });
  globalThis.fetch = async (_url, init) => {
    if (requests++ === 0) return response([call("test")]);
    const body = JSON.parse(String(init?.body));
    assert.equal(JSON.parse(body.input.at(-1).output).isError, true);
    return response([{ type: "message", content: [{ type: "output_text", text: "评分失败" }] }]);
  };
  assert.equal((await runAgentLoop([], options, { currentCourseId: 12 })).finalText, "评分失败");
});

test("LLM请求超时和外部取消传播fetch，HTTP分类和Retry-After不丢失", async () => {
  config(ok);
  process.env.LLM_REQUEST_TIMEOUT_MS = "20";
  let aborted = 0;
  let onStarted = () => {};
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted++; reject(init!.signal!.reason); }, { once: true });
    onStarted();
  });
  await assert.rejects(createResponse({ input: "test" }), (error: any) => error.code === "TIMEOUT");
  const controller = new AbortController();
  const cancellingStarted = new Promise<void>((resolve) => { onStarted = resolve; });
  const pending = createResponse({ input: "test" }, { signal: controller.signal });
  await cancellingStarted;
  controller.abort();
  await assert.rejects(pending, (error: any) => error.code === "CANCELLED" && !error.retryable);
  assert.equal(aborted, 2);
  globalThis.fetch = async () => Response.json(null, { status: 429 });
  await assert.rejects(createResponse({}), (error: any) => error.code === "HTTP_429" && error.retryable);
  globalThis.fetch = async () => Response.json(null);
  await assert.rejects(createResponse({}), (error: any) => error.code === "MODEL_OUTPUT_ERROR" && !error.retryable);
  for (const status of [429, 502, 401]) {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response("gateway", { status, headers: { "Retry-After": "2" } }); };
    await assert.rejects(createResponse({}), (error: any) => error.code === `HTTP_${status}` && error.retryAfterMs === 2000 && error.retryable === (status !== 401));
    assert.equal(requests, 1, "SDK 不应叠加任务层重试");
  }
});

test("SDK网络错误可重试，无效成功响应不可重试，预先取消不发请求", async () => {
  config(ok);
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new TypeError("fetch failed"); };
  await assert.rejects(createResponse({ input: "test" }), (error: any) => error.code === "NETWORK_ERROR" && error.retryable);
  assert.equal(requests, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createResponse({}, { signal: controller.signal }), (error: any) => error.code === "CANCELLED" && !error.retryable);
  assert.equal(requests, 1);
  for (const reply of [Response.json(null), new Response("invalid", { headers: { "Content-Type": "application/json" } }), Response.json({ error: { message: "failed" } })]) {
    globalThis.fetch = async () => reply;
    await assert.rejects(createResponse({}), (error: any) => error.code === "MODEL_OUTPUT_ERROR" && !error.retryable);
  }
});
