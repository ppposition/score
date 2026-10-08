import type { AgentExecutionContext, Tool, ToolResult } from "../types.js";
import { classifyError } from "../../api/errors.js";

function delegationTool(name: string, description: string, properties: Record<string, unknown>, required: string[],
  action: (args: Record<string, unknown>, context: AgentExecutionContext) => Promise<unknown>): Tool {
  return { name, description, parameters: { type: "object", properties, required, additionalProperties: false },
    handler: async (args, context): Promise<ToolResult> => {
      try {
        if (!context?.batchManager) throw new Error("当前运行没有会话批次管理器");
        const result = await action(args, context);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify(classifyError(error)) }] };
      }
    } };
}
const id = { type: "integer", minimum: 1 };
export const prepareGradingBatch = delegationTool("prepare-grading-batch", "准备并行评分批次，冻结题目与提交快照，不下载附件、不写回 Canvas", {
  courseId: id, assignmentId: id, assignmentFile: { type: "string", minLength: 1 },
  userIds: { type: "array", items: id, uniqueItems: true },
}, ["courseId", "assignmentId", "assignmentFile"], (args, context) => context.batchManager!.prepare(args));
export const delegateGrading = delegationTool("delegate-grading", "委派本批次1～50名学生给独立评分子 agent，等待本组全部结束；成功任务不重复评分", {
  batchId: { type: "string", format: "uuid" }, userIds: { type: "array", items: id, minItems: 1, maxItems: 50, uniqueItems: true },
  retryFailed: { type: "boolean", default: false },
}, ["batchId", "userIds"], (args, context) => context.batchManager!.delegate(args));
export const finalizeGradingBatch = delegationTool("finalize-grading-batch", "校验批次覆盖与成绩并保存成功记录和失败清单；仅本地保存，不写回 Canvas", {
  batchId: { type: "string", format: "uuid" },
}, ["batchId"], (args, context) => context.batchManager!.finalize(args));
