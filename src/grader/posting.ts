import "dotenv/config";

/** 默认满分只提交分数；false 可恢复满分也提交评语。 */
export function skipFullScoreComment(): boolean {
  return process.env.SKIP_FULL_SCORE_COMMENT?.trim().toLowerCase() !== "false";
}

export function toCanvasGrade(
  record: { score: number; maxScore?: number; comment: string },
  skipComment = skipFullScoreComment(),
): { posted_grade: number; text_comment?: string } {
  // 旧记录缺少 maxScore 时无法确定是否满分，保留评语。
  if (skipComment && Number.isFinite(record.maxScore) && record.score === record.maxScore) {
    return { posted_grade: record.score };
  }
  return { posted_grade: record.score, text_comment: record.comment };
}
