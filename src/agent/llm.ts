import "dotenv/config";
import { getAllTools } from "./registry.js";
import type { ChatMessage } from "./types.js";
import { toOpenAITool } from "./types.js";

const LLM_BASE = process.env.LLM_BASE_URL!;
const LLM_KEY = process.env.LLM_API_KEY!;
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o";

const AGENT_SYSTEM_PROMPT = `你是一个 Canvas LMS 自动评分助手。你可以使用以下工具来帮助用户完成课程管理、作业评分等任务。

工作流程：
1. 用户提出需求后，判断需要调用哪个工具
2. 调用工具并等待结果
3. 用中文将工具结果整理成清晰的回答给用户

注意：
- 如果工具调用需要参数而用户没提供，主动问用户要
- 如果工具返回错误，向用户说明原因
- 调用工具时带上完整的必要参数
- 保持回答简洁明了`;

export async function chat(
  messages: ChatMessage[],
): Promise<ChatMessage> {
  const tools = getAllTools().map(toOpenAITool);

  const response = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        ...messages,
      ],
      tools,
      tool_choice: "auto",
      temperature: 0.3,
    }),
  });

  const data = (await response.json()) as any;
  const choice = data.choices?.[0];
  if (!choice) throw new Error(`LLM 返回异常: ${JSON.stringify(data)}`);

  return choice.message as ChatMessage;
}
