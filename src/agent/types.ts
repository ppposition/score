/** Tool 定义 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** 会话上下文 */
export interface SessionContext {
  currentCourseId?: number;
  currentAssignmentId?: number;
}

/** OpenAI function calling 格式 */
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 确保 parameters 是合法 JSON Schema（OpenAI 要求 type: "object"） */
function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  if (!params || typeof params.type !== "string") {
    return { type: "object", properties: {} };
  }
  return params;
}

/** 将内部 Tool 转为 OpenAI function calling 格式 */
export function toOpenAITool(tool: Tool): OpenAIToolDef {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeParams(tool.parameters),
    },
  };
}

/** 对话消息 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}
