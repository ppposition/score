import { z } from "zod";
import { gradeSubmission, type GradeResult } from "../../grader/grader.js";
import { prepareAttachments } from "../../grader/attachments.js";
import { RequestError, type ExecutionError } from "../../api/errors.js";
import { runAgentLoop } from "../runtime.js";
import type { Tool } from "../types.js";
import type { GradingBatch, GradingTask } from "./types.js";
import { GRADER_SYSTEM_PROMPT } from "./prompts.js";

export async function runGrader(batch: GradingBatch, task: GradingTask, signal: AbortSignal): Promise<GradeResult> {
  let grading: Promise<GradeResult> | undefined;
  let record: GradeResult | undefined;
  let toolFailure: unknown;
  const tool: Tool = {
    name: "grade-assigned-submission", description: "评分当前绑定的学生提交，无参数",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async (args) => {
      z.object({}).strict().parse(args);
      grading ??= (async () => {
        try {
          const submission = batch.submissions.get(task.userId)!;
          const content = await prepareAttachments(submission.attachments, signal);
          return await gradeSubmission(content, batch.rubric, { ...submission, dueAt: batch.dueAt }, signal);
        } catch (error) { toolFailure = error; throw error; }
      })();
      record = await grading;
      return { content: [{ type: "text", text: JSON.stringify({ userId: task.userId, score: record.score, maxScore: record.maxScore }) }] };
    },
  };
  const result = await runAgentLoop([{ role: "user", content: `为当前绑定任务评分。batchId=${batch.batchId} taskId=${task.taskId} userId=${task.userId}` }], {
    name: `grader-${task.userId}`, instructions: GRADER_SYSTEM_PROMPT, tools: [tool], maxTurns: 4,
    stopAfterTools: [tool.name],
  }, { signal, task: { batchId: batch.batchId, taskId: task.taskId, userId: task.userId } });
  signal.throwIfAborted();
  if (toolFailure) throw toolFailure;
  if (result.status !== "completed" || !record) {
    const failure = result.error as ExecutionError | undefined;
    throw new RequestError(failure?.code ?? "SUBAGENT_FAILED", failure?.message ?? "子 agent 未生成正式成绩", failure?.retryable ?? false, failure?.retryAfterMs);
  }
  return record;
}
