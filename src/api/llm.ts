import "dotenv/config";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming, ResponseOutputItem } from "openai/resources/responses/responses";
import { RequestError, classifyError, positiveInteger } from "./errors.js";

export type { ResponseOutputItem };

export type InputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "high" };

export function requireVisionModel(): string {
  const model = process.env.LLM_VISION_MODEL?.trim();
  if (!model) throw new Error("扫描 PDF 需要视觉模型，请配置 LLM_VISION_MODEL（支持 Responses API 图片输入）");
  return model;
}

/** 共用 Responses API 请求与错误处理。 */
export async function createResponse(
  request: Omit<ResponseCreateParamsNonStreaming, "model" | "stream" | "store">,
  options: { vision?: boolean; signal?: AbortSignal } = {},
) {
  const model = options.vision ? requireVisionModel() : process.env.LLM_MODEL || "glm-5.3-flash";
  const baseURL = (options.vision ? process.env.LLM_VISION_BASE_URL || process.env.LLM_BASE_URL : process.env.LLM_BASE_URL)?.replace(/\/+$/, "");
  const apiKey = options.vision ? process.env.LLM_VISION_API_KEY || process.env.LLM_API_KEY : process.env.LLM_API_KEY;
  if (!baseURL || !apiKey) throw new Error("请配置 LLM_BASE_URL 和 LLM_API_KEY");

  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout: positiveInteger("LLM_REQUEST_TIMEOUT_MS", 120000),
    maxRetries: 0, // 由任务层统一重试。
  });
  try {
    const data = await client.responses.create({ ...request, model, stream: false, store: false }, { signal: options.signal });
    if (!data || data.error || data.status !== "completed" || !Array.isArray(data.output)) {
      throw new RequestError("MODEL_OUTPUT_ERROR", `LLM 响应未完成: ${data?.error?.message || data?.incomplete_details?.reason || data?.status || "缺少 output"}`);
    }
    options.signal?.throwIfAborted();
    return data;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof TypeError && !options.signal?.aborted)) {
      throw new RequestError("MODEL_OUTPUT_ERROR", "LLM 返回无效响应");
    }
    const failure = classifyError(error, options.signal);
    throw new RequestError(failure.code, failure.message, failure.retryable, failure.retryAfterMs);
  }
}

/** 只读取最终回答，排除 reasoning_text。 */
export function getResponseText(output: ResponseOutputItem[]): string {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text || "")
    .join("");
}
