import "dotenv/config";
import { RequestError, classifyError, positiveInteger, retryAfter } from "./errors.js";

export type InputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "high" };

export function requireVisionModel(): string {
  const model = process.env.LLM_VISION_MODEL?.trim();
  if (!model) throw new Error("扫描 PDF 需要视觉模型，请配置 LLM_VISION_MODEL（支持 Responses API 图片输入）");
  return model;
}

export interface ResponseOutputItem {
  type: string;
  id?: string;
  role?: string;
  content?: { type: string; text?: string }[];
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface LLMResponse {
  status: string;
  output: ResponseOutputItem[];
  error?: { message?: string; code?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

/** 共用 Responses API 请求与错误处理。 */
export async function createResponse(
  request: Record<string, unknown>,
  options: { vision?: boolean; signal?: AbortSignal } = {},
): Promise<LLMResponse> {
  const model = options.vision ? requireVisionModel() : process.env.LLM_MODEL || "glm-5.3-flash";
  const baseURL = (options.vision ? process.env.LLM_VISION_BASE_URL || process.env.LLM_BASE_URL : process.env.LLM_BASE_URL)?.replace(/\/+$/, "");
  const apiKey = options.vision ? process.env.LLM_VISION_API_KEY || process.env.LLM_API_KEY : process.env.LLM_API_KEY;
  if (!baseURL || !apiKey) throw new Error("请配置 LLM_BASE_URL 和 LLM_API_KEY");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("LLM 请求超时", "TimeoutError")), positiveInteger("LLM_REQUEST_TIMEOUT_MS", 120000));
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    signal.throwIfAborted();
    const response = await fetch(`${baseURL}/responses`, {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...request,
        model,
        stream: false,
        store: false,
      }),
    });

    const body = await response.text();
    let data: LLMResponse;
    try {
      data = JSON.parse(body) as LLMResponse;
    } catch {
      throw new RequestError(response.ok ? "MODEL_OUTPUT_ERROR" : `HTTP_${response.status}`, `LLM 返回非 JSON 响应 (HTTP ${response.status})`, response.status === 429 || response.status >= 500, retryAfter(response));
    }
    const responseError = data?.error;
    if (!response.ok || responseError) {
      throw new RequestError(`HTTP_${response.status}`, `LLM 调用失败 (HTTP ${response.status}): ${responseError?.message || responseError?.code || "未知错误"}`, response.status === 429 || response.status >= 500, retryAfter(response));
    }
    if (!data || data.status !== "completed" || !Array.isArray(data.output)) {
      throw new RequestError("MODEL_OUTPUT_ERROR", `LLM 响应未完成: ${data?.incomplete_details?.reason || data?.status || "缺少 output"}`);
    }
    signal.throwIfAborted();
    return data;
  } catch (error) {
    const failure = classifyError(error, signal);
    throw new RequestError(failure.code, failure.message, failure.retryable, failure.retryAfterMs);
  } finally {
    clearTimeout(timer);
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
