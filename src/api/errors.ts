import OpenAI from "openai";

export interface ExecutionError { code: string; message: string; retryable: boolean; retryAfterMs?: number }

export class RequestError extends Error {
  constructor(public code: string, message: string, public retryable = false, public retryAfterMs?: number) {
    super(message);
    this.name = "RequestError";
  }
}

export function redact(message: string): string {
  for (const key of [process.env.LLM_API_KEY, process.env.LLM_VISION_API_KEY, process.env.CANVAS_TOKEN]) {
    if (key) message = message.split(key).join("[REDACTED]");
  }
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/([?&](?:verifier|token|api_key)=)[^\s&]+/gi, "$1[REDACTED]");
}

export function classifyError(error: unknown, signal?: AbortSignal): ExecutionError {
  if (signal?.aborted) error = signal.reason;
  const message = redact(error instanceof Error ? error.message : String(error));
  if (error instanceof RequestError) return { code: error.code, message, retryable: error.retryable, retryAfterMs: error.retryAfterMs };
  if (error instanceof OpenAI.APIConnectionTimeoutError) return { code: "TIMEOUT", message, retryable: true };
  if (error instanceof OpenAI.APIUserAbortError) return { code: "CANCELLED", message, retryable: false };
  if (error instanceof OpenAI.APIConnectionError) return { code: "NETWORK_ERROR", message, retryable: true };
  if (error instanceof OpenAI.APIError && error.status !== undefined) {
    return { code: `HTTP_${error.status}`, message: `LLM 调用失败 (HTTP ${error.status}): ${message}`, retryable: error.status === 429 || error.status >= 500, retryAfterMs: retryAfter(error) };
  }
  if (error instanceof Error && error.name === "TimeoutError") return { code: "TIMEOUT", message, retryable: true };
  if (error instanceof Error && error.name === "AbortError") return { code: "CANCELLED", message, retryable: false };
  if (error instanceof TypeError && /fetch|network|connect|socket/i.test(message)) return { code: "NETWORK_ERROR", message, retryable: true };
  return { code: "VALIDATION_ERROR", message, retryable: false };
}

export function retryAfter(response: { headers?: Headers }): number | undefined {
  const value = response.headers?.get("retry-after");
  if (!value) return undefined;
  const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

export function positiveInteger(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} 必须是 1～${max} 的整数`);
  return value;
}
