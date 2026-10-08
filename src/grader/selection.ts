import "dotenv/config";
import type { Submission } from "../api/types.js";

/** 仅跳过当前已评分的提交；重新提交的作业仍可评分。 */
export function shouldSkipSubmission(submission: Pick<Submission, "workflow_state">): boolean {
  return process.env.SKIP_GRADED_SUBMISSIONS?.trim().toLowerCase() === "true"
    && submission.workflow_state === "graded";
}
