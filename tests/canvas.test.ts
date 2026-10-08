import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CANVAS_BASE_URL = "https://canvas.example.test";
process.env.CANVAS_TOKEN = "test-canvas-token";
const { downloadAttachment, getAssignments } = await import("../src/api/canvas.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("附件下载使用完整 URL，保留查询参数、认证和文件内容", async () => {
  const url = "https://canvas.example.test/files/14001143/download?download_frd=1&verifier=a%2Bb%2Fc";
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  globalThis.fetch = async (input) => {
    const request = input as Request;
    assert.equal(request.url, url);
    assert.equal(request.headers.get("Authorization"), "Bearer test-canvas-token");
    return new Response(bytes);
  };
  const dir = await mkdtemp(path.join(tmpdir(), "canvas-download-"));
  try {
    const savePath = path.join(dir, "submission.bin");
    await downloadAttachment(url, savePath);
    assert.deepEqual(await readFile(savePath), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Canvas API 请求仍使用 /api/v1 前缀和认证", async () => {
  globalThis.fetch = async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    assert.equal(url.origin, "https://canvas.example.test");
    assert.equal(url.pathname, "/api/v1/courses/123/assignments");
    assert.equal(request.headers.get("Authorization"), "Bearer test-canvas-token");
    return Response.json([]);
  };
  assert.deepEqual(await getAssignments(123), []);
});
