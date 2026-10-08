import { AGENT_SYSTEM_PROMPT } from "./llm.js";
import { getAllTools } from "./registry.js";
import { runAgentLoop } from "./runtime.js";
import { GradingBatchManager } from "./subagents/manager.js";
import type { AgentExecutionContext, ChatMessage, Tool } from "./types.js";

export function createAgentContext(): AgentExecutionContext {
  return { batchManager: new GradingBatchManager() };
}

/** 交互式对话和一次性 CLI 命令共用主 agent 配置与工具循环。 */
export function runMainAgent(messages: ChatMessage[], context: AgentExecutionContext, tools: Tool[] = getAllTools()) {
  return runAgentLoop(messages, {
    name: "canvas-agent", instructions: AGENT_SYSTEM_PROMPT, tools, maxTurns: 10,
  }, context);
}
