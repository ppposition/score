import { chat } from "./llm.js";
import type { AgentExecutionContext, AgentRunConfig, AgentRunResult, ChatMessage } from "./types.js";
import { classifyError } from "../api/errors.js";

/** 顺序执行本次运行允许的工具，保留每个 Responses call_id。 */
export async function runAgentLoop(
  messages: ChatMessage[], config: AgentRunConfig, context: AgentExecutionContext,
): Promise<AgentRunResult> {
  try {
    for (let turn = 0; turn < config.maxTurns; turn++) {
      context.signal?.throwIfAborted();
      const reply = await chat(messages, config, context.signal);
      messages.push(reply);
      if (!reply.tool_calls?.length) {
        if (config.stopAfterTools?.length) return {
          status: "failed", messages, error: { code: "REQUIRED_TOOL_NOT_CALLED", message: "子 agent 未调用正式评分工具" },
        };
        return { status: "completed", messages, finalText: reply.content ?? "" };
      }
      let stop = false;
      let fatal: AgentRunResult["error"];
      for (const call of reply.tool_calls) {
        try {
          context.signal?.throwIfAborted();
          const tool = config.tools.find((tool) => tool.name === call.function.name);
          if (!tool) throw new Error(`未知工具: ${call.function.name}`);
          const parsed: unknown = JSON.parse(call.function.arguments);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工具参数必须是 JSON 对象");
          const args = parsed as Record<string, unknown>;
          const properties = tool.parameters.properties as Record<string, unknown> | undefined;
          if (properties?.courseId && context.currentCourseId && args.courseId === undefined) args.courseId = context.currentCourseId;
          if (properties?.assignmentId && context.currentAssignmentId && args.assignmentId === undefined) args.assignmentId = context.currentAssignmentId;
          // 子 agent 任一工具失败后，为其余 call_id 输出错误而不继续执行。
          if (fatal) throw new Error("本次子 agent 工具执行已失败");
          const result = await tool.handler(args, context);
          messages.push({ role: "tool", tool_call_id: call.id,
            content: JSON.stringify(result) });
          if (result.isError) {
            if (config.stopAfterTools?.length) fatal = { code: "TOOL_ERROR", message: result.content.map((c) => c.text).join("\n") };
          } else if (config.stopAfterTools?.includes(tool.name)) stop = true;
        } catch (error) {
          const failure = classifyError(error, context.signal);
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ isError: true, error: failure }) });
          if (config.stopAfterTools?.length && !fatal) fatal = failure;
        }
      }
      if (fatal) return { status: "failed", messages, error: fatal };
      if (stop) return { status: "completed", messages };
    }
    return { status: "max_turns", messages, error: { code: "MAX_TURNS", message: "达到最大工具循环轮数，任务未完成" } };
  } catch (error) {
    return { status: "failed", messages, error: classifyError(error, context.signal) };
  }
}
