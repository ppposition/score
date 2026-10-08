import { z } from "zod";
import type { GradeResult } from "../../grader/grader.js";
import { getLatePenalty } from "../../grader/late.js";
import type { GradingBatch } from "./types.js";
const number = z.number().finite().nonnegative();
const schema = z.object({
  score: number, baseScore: number, latePenalty: number, lateSeconds: number, maxScore: number,
  comment: z.string(), items: z.array(z.object({ id: z.string(),
    status: z.enum(["complete", "missing", "incomplete", "perfunctory"]), reason: z.string().trim().min(1),
    score: number, maxScore: number,
  })),
});
/** 只检查正式成绩，不重算或覆盖成绩字段。 */
export function validateGrade(value: unknown, batch: GradingBatch, userId: number): GradeResult {
  const result = schema.parse(value);
  const ids = new Set(result.items.map((item) => item.id));
  if (ids.size !== result.items.length || result.items.length !== batch.rubric.items.length || batch.rubric.items.some((item) => !ids.has(item.id))) throw new Error("成绩题号缺失、重复或不匹配");
  if (result.items.some((item) => item.maxScore !== 10 || item.score !== (item.status === "complete" ? 10 : 0))) throw new Error("成绩计分项不符合评分规则");
  const baseScore = result.items.reduce((sum, item) => sum + item.score, 0);
  const late = getLatePenalty({ ...batch.submissions.get(userId)!, dueAt: batch.dueAt });
  if (result.maxScore !== batch.rubric.items.length * 10 || result.baseScore !== baseScore || result.lateSeconds !== late.lateSeconds || result.latePenalty !== late.latePenalty || result.score !== Math.max(0, baseScore - late.latePenalty)) throw new Error("成绩总分或迟交数据不一致");
  return result;
}
