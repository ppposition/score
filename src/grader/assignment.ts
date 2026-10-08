import type { AssignmentRubric } from "./grader.js";

/** 标准 Markdown 题目按标题和显式小题编号解析，避免模型生成题号。 */
export function parseMarkdownAssignment(text: string): AssignmentRubric | undefined {
  const items: AssignmentRubric["items"] = [];
  let chapter = "";
  let question: { id: string; lines: string[] } | undefined;
  let fenced = false;
  let math = false;

  function finishQuestion() {
    if (!question) return;
    const common: string[] = [];
    const parts: { label: string; lines: string[] }[] = [];
    let inCode = false;
    let inMath = false;
    for (const line of question.lines) {
      const marker = !inCode && !inMath
        ? line.match(/^\s*(?:[-*+]\s+)?(?:([0-9]+)[.、．]\s+|[（(]([0-9]+|[a-zA-Z])[）)]\s*)(.*)$/)
        : null;
      if (marker) {
        parts.push({ label: marker[1] ?? marker[2], lines: [marker[3]] });
      } else {
        (parts.length ? parts[parts.length - 1].lines : common).push(line);
      }
      if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
      if (!inCode && /^\s*\$\$/.test(line) && (line.match(/\$\$/g)?.length ?? 0) % 2 === 1) inMath = !inMath;
    }
    if (!question.lines.join("\n").trim()) throw new Error(`题目 ${question.id} 没有正文`);
    if (parts.length) {
      for (const part of parts) {
        items.push({ id: `${question.id}(${part.label})`, requirement: `${question.id}\n${common.join("\n")}\n(${part.label}) ${part.lines.join("\n")}`.trim() });
      }
    } else {
      items.push({ id: question.id, requirement: `${question.id}\n${question.lines.join("\n")}`.trim() });
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const heading = !fenced && !math ? line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/) : null;
    const chapterHeading = heading?.[1].match(/^第\s*([0-9一二三四五六七八九十百]+)\s*章(?:\s*习题)?$/);
    const questionHeading = heading?.[1].match(/^第\s*([0-9一二三四五六七八九十百]+)\s*题(?:\s*[:：].*)?$/);
    if (chapterHeading || questionHeading) {
      finishQuestion();
      question = undefined;
      if (chapterHeading) chapter = `第${chapterHeading[1]}章`;
      if (questionHeading) question = { id: `${chapter}第${questionHeading[1]}题`, lines: [] };
    } else if (question) {
      question.lines.push(line);
    }
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^\s*\$\$/.test(line) && (line.match(/\$\$/g)?.length ?? 0) % 2 === 1) math = !math;
  }
  finishQuestion();
  if (!items.length) return undefined;
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`题目文件中题号或小题号重复：${item.id}，请检查章节和编号`);
    seen.add(item.id);
  }
  return { items };
}
