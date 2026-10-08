import { z } from "zod";
import { createAgentContext, runMainAgent } from "./main.js";
import { prepareGradingBatch, delegateGrading, finalizeGradingBatch } from "./tools/delegation.js";
import { postGradesTool } from "./tools/grading.js";
import type { AgentExecutionContext, Tool, ToolResult } from "./types.js";

const optionsSchema = z.object({
  course: z.number().int().positive(), assignment: z.number().int().positive(),
  assignmentFile: z.string().trim().min(1), dryRun: z.boolean().default(false),
  includeFullScoreComment: z.boolean().default(false),
});
export type GradeOptions = z.input<typeof optionsSchema>;

/** 将 CLI 参数交给主 agent，限定批量评分范围并保留命令行写回策略。 */
export async function runGradingAgent(options: GradeOptions, context: AgentExecutionContext = createAgentContext()): Promise<void> {
  const opts = optionsSchema.parse(options);
  let preparation: Promise<ToolResult> | undefined;
  let posting: Promise<ToolResult> | undefined;
  let recordFile: string | undefined;
  let needsPosting = false;
  const tools: Tool[] = [
    { ...prepareGradingBatch, handler: (args, ctx) => preparation ??= prepareGradingBatch.handler({
      ...args, userIds: undefined, courseId: opts.course, assignmentId: opts.assignment, assignmentFile: opts.assignmentFile,
    }, ctx) },
    delegateGrading,
    { ...finalizeGradingBatch, handler: async (args, ctx) => {
      const result = await finalizeGradingBatch.handler(args, ctx);
      if (!result.isError) {
        const summary = JSON.parse(result.content[0].text);
        recordFile = summary.recordFile;
        needsPosting = !opts.dryRun && summary.progress.succeeded > 0;
        console.log(`评分记录已保存: ${recordFile}（${summary.status}，成功 ${summary.progress.succeeded}，失败 ${summary.progress.failed}）`);
      }
      return result;
    } },
  ];
  if (!opts.dryRun) tools.push({ ...postGradesTool, handler: async (_args, ctx) => {
    if (!recordFile) throw new Error("必须先汇总当前批次才能写回");
    const result = await (posting ??= postGradesTool.handler({ courseId: opts.course, assignmentId: opts.assignment,
      recordFile, ...(opts.includeFullScoreComment ? { skipFullScoreComment: false } : {}),
    }, ctx));
    if (!result.isError) needsPosting = false;
    return result;
  } });
  const result = await runMainAgent([{ role: "user", content:
    `给以下课程作业的所有符合条件学生评分，使用 subagent 并行处理：${JSON.stringify(opts)}。\n` +
    `使用 prepare-grading-batch → delegate-grading → finalize-grading-batch，完整覆盖所有待评分学生。\n` +
    (opts.dryRun ? "只保存本地记录，不写回 Canvas。" : "汇总保存后使用 post-grades 将成功记录写回 Canvas；部分失败需明确说明。") +
    (opts.includeFullScoreComment ? "满分也提交评语。" : "满分评语遵循环境设置。"),
  }], context, tools);
  const progress = context.batchManager?.progress();
  if (result.status !== "completed" || !recordFile || needsPosting || progress?.some((batch) => batch.unfinishedUserIds.length)) {
    throw new Error(`${result.error?.message ?? (needsPosting ? "成绩已保存，但写回未完成" : "评分汇总未完成")}；批次进度：${JSON.stringify(progress)}`);
  }
  if (result.finalText) console.log(`\n${result.finalText}\n`);
}
