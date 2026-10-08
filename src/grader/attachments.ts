import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { RequestError, classifyError, retryAfter } from "../api/errors.js";
import type { Attachment } from "../api/types.js";
import { requireVisionModel, type InputContent } from "../api/llm.js";

// 等到进程 close 后才释放资源；execFile 的 abort 回调可能早于退出。
function run(file: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    let failure: Error | null = null;
    let stdout = "";
    const child = execFile(file, args, { ...options, killSignal: "SIGKILL" }, (error, output) => { failure = error; stdout = output; });
    child.on("error", (error) => { failure = error; });
    child.on("close", () => failure ? reject(failure) : resolve({ stdout }));
  });
}
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 30;

function checkSize(size: number, filename: string) {
  if (size > MAX_BYTES) throw new Error(`附件 ${filename} 超过 50 MiB 限制`);
}

function isPdf(filename: string, mime: string, bytes?: Buffer): boolean {
  return /\.pdf$/i.test(filename) || mime.split(";")[0].trim() === "application/pdf"
    || bytes?.subarray(0, 5).toString("ascii") === "%PDF-";
}

/** 扫描件必须读取页面图像，不能用 UTF-8 或仅提取 PDF 文本。 */
async function renderPdf(bytes: Buffer, filename: string, signal?: AbortSignal): Promise<InputContent[]> {
  signal?.throwIfAborted();
  requireVisionModel();
  const dir = await fs.mkdtemp(path.join(tmpdir(), "canvas-pdf-"));
  try {
    const input = path.join(dir, "input.pdf");
    await fs.writeFile(input, bytes);
    const { stdout } = await run("pdfinfo", [input], { signal, timeout: 30_000, env: { ...process.env, LC_ALL: "C" } });
    const pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!Number.isInteger(pages) || pages < 1) throw new Error(`无法获取 PDF ${filename} 的页数`);
    if (pages > MAX_PAGES) throw new Error(`PDF ${filename} 有 ${pages} 页，超过 ${MAX_PAGES} 页限制；请拆分后提交`);
    const content: InputContent[] = [];
    let imageBytes = 0;
    for (let page = 1; page <= pages; page++) {
      const prefix = path.join(dir, "page");
      await run("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-scale-to", "2400", "-jpeg", "-jpegopt", "quality=90", input, prefix], { signal, timeout: 60_000 });
      const image = await fs.readFile(`${prefix}.jpg`);
      imageBytes += image.length;
      checkSize(imageBytes, `${filename} 的页面图片`);
      content.push({ type: "input_text", text: `附件：${filename}，第 ${page}/${pages} 页` });
      content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${image.toString("base64")}`, detail: "high" });
    }
    return content;
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("处理扫描 PDF 需要 Poppler，请安装 pdfinfo 和 pdftoppm（Ubuntu/Debian: apt-get install poppler-utils）");
    }
    throw new Error(`处理 PDF ${filename} 失败：${(error as Error).message}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function prepare(bytes: Buffer, filename: string, mime = "", signal?: AbortSignal): Promise<InputContent[]> {
  signal?.throwIfAborted();
  checkSize(bytes.length, filename);
  if (isPdf(filename, mime, bytes)) return renderPdf(bytes, filename, signal);
  if (!/\.(md|markdown|txt|ipynb|json|csv|py|html?)$/i.test(filename)
      && !mime.startsWith("text/") && mime !== "application/json" && mime !== "application/x-ipynb+json") {
    throw new Error(`不支持的附件格式：${filename}（支持 PDF、MD 和文本文件）`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`附件 ${filename} 不是有效的 UTF-8 文本`);
  }
  if (!text.trim()) throw new Error(`附件 ${filename} 内容为空`);
  return [{ type: "input_text", text: `附件：${filename}\n${text}` }];
}

/** agent /attach 读取本地文件，保留 Markdown 原文、公式及代码块。 */
export async function prepareLocalAttachment(filePath: string): Promise<InputContent[]> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("附件路径必须是文件");
  checkSize(stat.size, path.basename(filePath));
  return prepare(await fs.readFile(filePath), path.basename(filePath));
}

/** Canvas 与 CLI 共用附件加载，不将二进制文件当成普通文本。 */
export async function prepareAttachments(attachments: Attachment[], signal?: AbortSignal): Promise<InputContent[]> {
  signal?.throwIfAborted();
  if (!attachments.length) throw new Error("提交没有附件，无法评分");
  const content: InputContent[] = [];
  let totalBytes = 0;
  let pages = 0;
  for (const attachment of attachments) {
    checkSize(attachment.size, attachment.filename);
    if (isPdf(attachment.filename, attachment["content-type"])) requireVisionModel();
    const downloadController = new AbortController();
    const downloadTimer = setTimeout(() => downloadController.abort(new DOMException("附件下载超时", "TimeoutError")), 60_000);
    const downloadSignal = signal ? AbortSignal.any([signal, downloadController.signal]) : downloadController.signal;
    try {
      const response = await fetch(attachment.url, {
        headers: { Authorization: `Bearer ${process.env.CANVAS_TOKEN}` },
        signal: downloadSignal,
      });
      if (!response.ok) throw new RequestError(`HTTP_${response.status}`, `下载附件 ${attachment.filename} 失败（HTTP ${response.status}）`, response.status === 429 || response.status >= 500, retryAfter(response));
      checkSize(Number(response.headers.get("content-length") || 0), attachment.filename);
      // 流式限制大小，避免缺少 Content-Length 时无限制读取响应。
      if (!response.body) throw new Error(`附件 ${attachment.filename} 响应为空`);
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        downloadSignal.throwIfAborted();
        totalBytes += chunk.length;
        checkSize(totalBytes, "本次提交");
        chunks.push(chunk);
      }
      clearTimeout(downloadTimer);
      const parts = await prepare(Buffer.concat(chunks), attachment.filename, attachment["content-type"] || response.headers.get("content-type") || "", signal);
      pages += parts.filter((part) => part.type === "input_image").length;
      if (pages > MAX_PAGES) throw new Error(`本次提交的 PDF 总页数超过 ${MAX_PAGES} 页，请拆分后提交`);
      content.push(...parts);
    } catch (error) {
      const failure = classifyError(error, downloadSignal);
      throw new RequestError(failure.code, failure.message, failure.retryable, failure.retryAfterMs);
    } finally { clearTimeout(downloadTimer); }
  }
  return content;
}
