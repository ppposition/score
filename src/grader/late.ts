import type { Submission } from "../api/types.js";

export type SubmissionTiming = Pick<Submission, "late" | "submitted_at" | "seconds_late" | "cached_due_date"> & {
  dueAt?: string | null;
};

/** 使用 Canvas 的迟交时长；旧接口则根据提交时间和截止时间计算。 */
export function getLatePenalty(timing?: SubmissionTiming): { lateSeconds: number; latePenalty: number } {
  if (!timing?.late) return { lateSeconds: 0, latePenalty: 0 };
  let seconds = timing.seconds_late;
  if (seconds == null) {
    const dueAt = timing.cached_due_date !== undefined ? timing.cached_due_date : timing.dueAt;
    seconds = timing.submitted_at && dueAt
      ? (Date.parse(timing.submitted_at) - Date.parse(dueAt)) / 1000
      : NaN;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("提交标记为迟交，但无法确定有效迟交时长，请检查 Canvas 的提交时间、截止时间或 seconds_late");
  }
  const days = seconds / 86400;
  const latePenalty = days <= 1 ? 10 : days <= 2 ? 20 : days <= 7 ? 30 : days <= 28 ? 40 : 50;
  return { lateSeconds: seconds, latePenalty };
}
