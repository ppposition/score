import "dotenv/config";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { ChatMessage, AgentRunConfig } from "./types.js";
import { toOpenAITool } from "./types.js";
import { createResponse, getResponseText } from "../api/llm.js";

export const AGENT_SYSTEM_PROMPT = `你是一个 Canvas LMS 自动评分助手。你可以使用以下工具来帮助用户完成课程管理、作业评分等任务。

工作流程：
1. 用户提出需求后，判断需要调用哪个工具
2. 调用工具并等待结果
3. 用中文将工具结果整理成清晰的回答给用户

注意：
- 如果工具调用需要参数而用户没提供，主动问用户要
- 如果工具返回错误，向用户说明原因
- 调用工具时带上完整的必要参数
- 评分必须使用正式评分工具（grade-submission、grade-all 或并行批次工具），要求用户指定本地题目文件 assignmentFile，不能用 Canvas 描述或对话中的学生附件代替题目文件。工具先提取题目，再加载对应学生附件。每个小题10分，无小题整题10分，只看完整性和是否明显敷衍，不判断对错；满分按计分项数量计算。
- 用户指定 subagent 或并行评分时，使用 prepare-grading-batch → delegate-grading → finalize-grading-batch；待评分作业较多（需要评分的学生提交较多）时，即使用户未明确要求，也应主动启用 subagent 并行评分。遵循用户明确指定的评分方式，单人普通评分可用 grade-submission。
- 只使用 prepare 返回的学生 ID，覆盖所有待评分学生；delegate 每次最多50人，可分轮执行。成绩来自工具，不能自行改分。
- 尚未完成或达到轮数上限时明确说明未完成批次。部分成功说明成功和失败人数，不能声称全部成功。
- 用户要求先不写回时，只保存记录并报告路径；后续明确请求写回时才用 post-grades。完整批次与部分成功记录必须明确区分。
- 保持回答简洁明了`;

export async function chat(
  messages: ChatMessage[],
  config: Pick<AgentRunConfig, "instructions" | "tools">,
  signal?: AbortSignal,
): Promise<ChatMessage> {
  const tools = config.tools.map(toOpenAITool);

  const input: ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id) throw new Error("工具结果缺少 tool_call_id");
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content || "" });
    } else if (message.response_output) {
      // SDK 的输出联合类型包含额外项；这里原样回传已有推理和工具上下文。
      input.push(...message.response_output as ResponseInputItem[]);
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
    instructions: config.instructions,
    input,
    tools,
    tool_choice: "auto",
    temperature: 0.3,
  }, { vision, signal });

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
