import "dotenv/config";

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
  options: { vision?: boolean } = {},
): Promise<LLMResponse> {
  const model = options.vision ? requireVisionModel() : process.env.LLM_MODEL || "glm-5.3-flash";
  const baseURL = (options.vision ? process.env.LLM_VISION_BASE_URL || process.env.LLM_BASE_URL : process.env.LLM_BASE_URL)?.replace(/\/+$/, "");
  const apiKey = options.vision ? process.env.LLM_VISION_API_KEY || process.env.LLM_API_KEY : process.env.LLM_API_KEY;
  if (!baseURL || !apiKey) throw new Error("请配置 LLM_BASE_URL 和 LLM_API_KEY");

  const response = await fetch(`${baseURL}/responses`, {
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
    throw new Error(`LLM 返回非 JSON 响应 (HTTP ${response.status})`);
  }
  if (!response.ok || data.error) {
    throw new Error(`LLM 调用失败 (HTTP ${response.status}): ${data.error?.message || data.error?.code || "未知错误"}`);
  }
  if (data.status !== "completed" || !Array.isArray(data.output)) {
    throw new Error(`LLM 响应未完成: ${data.incomplete_details?.reason || data.status || "缺少 output"}`);
  }
  return data;
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
