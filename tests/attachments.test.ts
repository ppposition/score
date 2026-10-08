import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { prepareAttachments, prepareLocalAttachment } from "../src/grader/attachments.js";
import { gradeSubmission } from "../src/grader/grader.js";
import { chat } from "../src/agent/llm.js";
import type { Attachment } from "../src/api/types.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function attachment(filename: string, mime = "application/octet-stream"): Attachment {
  return { id: 1, filename, display_name: filename, url: "https://canvas.test/download?verifier=a%2Bb", "content-type": mime, size: 1 };
}

/** 两页仅含 RGB 图像的 PDF，不含文字层；页一红色、页二蓝色。 */
function scannedPdf(): Buffer {
  const stream = (value: Buffer, attributes = "") => Buffer.concat([
    Buffer.from(`<< ${attributes} /Length ${value.length} >>\nstream\n`), value, Buffer.from("\nendstream"),
  ]);
  const image = (rgb: number[]) => stream(Buffer.from(rgb), "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>"),
    stream(Buffer.from("q 72 0 0 72 0 0 cm /Im Do Q")), image([255, 0, 0]),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << /XObject << /Im 8 0 R >> >> /Contents 7 0 R >>"),
    stream(Buffer.from("q 72 0 0 72 0 0 cm /Im Do Q")), image([0, 0, 255]),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from("\nendobj\n"));
  }
  const xref = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

test("扫描 PDF 与 Markdown 混合提交：按页序渲染，视觉请求携带真实图片与 MD 原文", async () => {
  process.env.LLM_BASE_URL = "https://text.test/v1";
  process.env.LLM_API_KEY = "text-key";
  process.env.LLM_VISION_BASE_URL = "https://vision.test/v1/";
  process.env.LLM_VISION_API_KEY = "vision-key";
  process.env.LLM_VISION_MODEL = "test-vision";
  process.env.CANVAS_TOKEN = "canvas-key";
  const md = "# 解答\n中文分析\n```python\nprint(1)\n```\n$x^2$";
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://canvas.test")) {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer canvas-key");
      return new Response(String(url).endsWith("md") ? md : scannedPdf());
    }
    assert.equal(String(url), "https://vision.test/v1/responses");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer vision-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "test-vision");
    const parts = body.input[0].content;
    assert.equal(parts.filter((part: any) => part.type === "input_image").length, 2);
    assert.ok(parts.some((part: any) => part.text?.includes(md)));
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"items":[{"id":"1","status":"complete","reason":"推导完整"}],"comment":"作答完整"}' }] }] });
  };
  const content = await prepareAttachments([
    attachment("scan.PDF"), { ...attachment("answer.md"), url: "https://canvas.test/md" },
  ]);
  assert.match(content[0].type === "input_text" ? content[0].text : "", /第 1\/2 页/);
  assert.match(content[2].type === "input_text" ? content[2].text : "", /第 2\/2 页/);
  const images = content.filter((part) => part.type === "input_image");
  assert.notEqual(images[0].image_url, images[1].image_url);
  for (const image of images) {
    const bytes = Buffer.from(image.image_url.split(",")[1], "base64");
    assert.equal(bytes.subarray(0, 2).toString("hex"), "ffd8");
    assert.equal(image.detail, "high");
  }
  const result = await gradeSubmission(content, { items: [{ id: "1", requirement: "提交推导" }] });
  assert.equal(result.score, 10);
  assert.equal(result.maxScore, 10);
});

test("本地 MD 保留原文，文本评分无需视觉配置", async () => {
  delete process.env.LLM_VISION_MODEL;
  process.env.LLM_BASE_URL = "https://text.test/v1";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "text-model";
  const dir = await fs.mkdtemp(path.join(tmpdir(), "attachment-test-"));
  try {
    const file = path.join(dir, "评分 标准.markdown");
    await fs.writeFile(file, "# 标准\n公式 $x$\n```js\n1\n```");
    const parts = await prepareLocalAttachment(file);
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "text-model");
      assert.match(body.input[0].content[1].text, /公式 \$x\$/);
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"items":[{"id":"1","status":"complete","reason":"已完整作答"}],"comment":"作答完整"}' }] }] });
    };
    assert.equal((await gradeSubmission(parts, { items: [{ id: "1", requirement: "要求" }] })).score, 10);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("附件下载失败、空附件、非 UTF-8 和不支持格式不进入评分", async () => {
  await assert.rejects(prepareAttachments([]), /没有附件/);
  globalThis.fetch = async () => new Response("denied", { status: 403 });
  await assert.rejects(prepareAttachments([attachment("a.md")]), /HTTP 403/);
  globalThis.fetch = async () => new Response(Buffer.from([255, 254, 128]));
  await assert.rejects(prepareAttachments([attachment("a.md")]), /UTF-8/);
  await assert.rejects(prepareAttachments([attachment("a.docx")]), /不支持/);
  globalThis.fetch = async () => new Response("   ");
  await assert.rejects(prepareAttachments([attachment("a.md")]), /内容为空/);
});

test("缺少视觉配置、超大文件和损坏 PDF 明确报错", async () => {
  delete process.env.LLM_VISION_MODEL;
  globalThis.fetch = async () => { throw new Error("不应发起下载"); };
  await assert.rejects(prepareAttachments([attachment("a.pdf")]), /LLM_VISION_MODEL/);
  await assert.rejects(prepareAttachments([{ ...attachment("a.md"), size: 51 * 1024 * 1024 }]), /50 MiB/);
  process.env.LLM_VISION_MODEL = "test-vision";
  globalThis.fetch = async () => new Response("%PDF-corrupted");
  await assert.rejects(prepareAttachments([attachment("a.pdf")]), /处理 PDF.*失败/);
});

test("本地 PDF 多轮对话保留图片输入并继续使用视觉模型", async () => {
  process.env.LLM_BASE_URL = "https://example.test/v1";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_VISION_MODEL = "test-vision";
  delete process.env.LLM_VISION_BASE_URL;
  delete process.env.LLM_VISION_API_KEY;
  const message = { role: "user" as const, content: "看附件", input_content: [{ type: "input_image" as const, image_url: "data:image/jpeg;base64,test", detail: "high" as const }] };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "test-vision");
    assert.deepEqual(body.input[0].content, message.input_content);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "已阅读" }] }] });
  };
  const reply = await chat([message]);
  assert.equal((await chat([message, reply, { role: "user", content: "继续" }])).content, "已阅读");
});
