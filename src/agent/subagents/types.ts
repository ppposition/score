import type { Submission } from "../../api/types.js";
import type { AssignmentRubric, GradeResult } from "../../grader/grader.js";
import { z } from "zod";

export const prepareSchema = z.object({
  courseId: z.number().int().positive(), assignmentId: z.number().int().positive(),
  assignmentFile: z.string().trim().min(1), userIds: z.array(z.number().int().positive()).optional(),
}).strict().refine((v) => !v.userIds || new Set(v.userIds).size === v.userIds.length, "学生 ID 不能重复");
export const delegateSchema = z.object({
  batchId: z.string().uuid(), userIds: z.array(z.number().int().positive()).min(1).max(50),
  retryFailed: z.boolean().default(false),
}).strict().refine((v) => new Set(v.userIds).size === v.userIds.length, "学生 ID 不能重复");
export const finalizeSchema = z.object({ batchId: z.string().uuid() }).strict();
export type TaskStatus = "pending" | "running" | "succeeded" | "failed";
export type BatchStatus = "prepared" | "running" | "completed" | "partial" | "failed";
export interface GradingTask {
  taskId: string; userId: number; status: TaskStatus; attempts: number;
  startedAt?: string; finishedAt?: string;
  error?: import("../../api/errors.js").ExecutionError;
  result?: GradeResult;
}
export interface GradingBatch {
  batchId: string; courseId: number; assignmentId: number; assignmentFile: string;
  rubric: AssignmentRubric; status: BatchStatus; createdAt: string;
  submissions: ReadonlyMap<number, Submission>; studentNames: ReadonlyMap<number, string>;
  dueAt?: string | null; tasks: Map<number, GradingTask>;
  skipped: { userId: number; reason: string }[];
  recordFile?: string; manifestFile?: string;
  revision: number; savedRevision?: number;
}
