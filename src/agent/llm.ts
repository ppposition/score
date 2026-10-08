import "dotenv/config";
import { getAllTools } from "./registry.js";
import type { ChatMessage } from "./types.js";
import { toOpenAITool } from "./types.js";
import { createResponse, getResponseText } from "../api/llm.js";

const AGENT_SYSTEM_PROMPT = `你是一个 Canvas LMS 自动评分助手。你可以使用以下工具来帮助用户完成课程管理、作业评分等任务。

工作流程：
1. 用户提出需求后，判断需要调用哪个工具
2. 调用工具并等待结果
3. 用中文将工具结果整理成清晰的回答给用户

注意：
- 如果工具调用需要参数而用户没提供，主动问用户要
- 如果工具返回错误，向用户说明原因
- 调用工具时带上完整的必要参数
- 评分必须调用 grade-submission 或 grade-all，要求用户指定本地题目文件 assignmentFile，不能用 Canvas 描述或对话中的学生附件代替题目文件。工具先提取题目，再加载对应学生附件。每个小题10分，无小题整题10分，只看完整性和是否明显敷衍，不判断对错；满分按计分项数量计算。
- 保持回答简洁明了`;

export async function chat(
  messages: ChatMessage[],
): Promise<ChatMessage> {
  const tools = getAllTools().map(toOpenAITool);

  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id) throw new Error("工具结果缺少 tool_call_id");
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content || "" });
    } else if (message.response_output) {
      input.push(...message.response_output.map((item) => ({ ...item })));
    } else {
      if (message.content !== null) {
        input.push({ type: "message", role: message.role, content: message.input_content ?? message.content });
      }
      for (const call of message.tool_calls || []) {
        input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }

  const vision = messages.some((message) => message.input_content?.some((part) => part.type === "input_image"));
  const data = await createResponse({
    instructions: AGENT_SYSTEM_PROMPT,
    input,
    tools,
    tool_choice: "auto",
    temperature: 0.3,
  }, { vision });

  const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
  for (const item of data.output) {
    if (item.type !== "function_call") continue;
    if (!item.call_id || !item.name || typeof item.arguments !== "string") {
      throw new Error("LLM 工具调用缺少 call_id、name 或 arguments");
    }
    toolCalls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
  }
  const content = getResponseText(data.output);
  if (!content && !toolCalls.length) throw new Error("LLM 未返回回答或工具调用");
  return {
    role: "assistant",
    content: content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    response_output: data.output,
  };
}
