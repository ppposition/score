import "dotenv/config";
import { z } from "zod";
import { ASSIGNMENT_PROMPT, SYSTEM_PROMPT, SCORING_PROMPT } from "./prompts.js";
import { createResponse, getResponseText } from "../api/llm.js";
import type { InputContent } from "../api/llm.js";
import { prepareLocalAttachment } from "./attachments.js";
import { parseMarkdownAssignment } from "./assignment.js";

const assignmentSchema = z.object({
  items: z.array(z.object({ id: z.string().trim().min(1), requirement: z.string().trim().min(1) })).min(1),
});
export type AssignmentRubric = z.infer<typeof assignmentSchema>;
const evaluationSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    status: z.enum(["complete", "missing", "incomplete", "perfunctory", "unreadable"]),
    reason: z.string().trim().min(1),
  })),
  comment: z.string(),
});
export interface GradeResult {
  score: number;
  maxScore: number;
  comment: string;
  items: (z.infer<typeof evaluationSchema>["items"][number] & { score: number; maxScore: number })[];
}

function parseJson(raw: string): unknown {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("解析 LLM JSON 输出失败");
  return JSON.parse(jsonMatch[0]);
}

function validateRubric(value: unknown): AssignmentRubric {
  const rubric = assignmentSchema.parse(value);
  if (new Set(rubric.items.map((item) => item.id)).size !== rubric.items.length) {
    const ids = rubric.items.map((item) => item.id);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    throw new Error(`作业计分项 id 重复：${duplicates.join("、")}`);
  }
  return rubric;
}

/** 在加载学生附件前提取题目；批量评分共用同一清单。 */
export async function extractAssignment(content: string | InputContent[]): Promise<AssignmentRubric> {
  if (typeof content === "string" && !content.trim()) throw new Error("作业题目内容为空");
  const data = await createResponse({
    instructions: ASSIGNMENT_PROMPT,
    input: typeof content === "string" ? content : [{ role: "user", content }],
    temperature: 0,
    text: { format: { type: "json_object" } },
  }, { vision: Array.isArray(content) && content.some((part) => part.type === "input_image") });
  return validateRubric(parseJson(getResponseText(data.output)));
}

export async function loadAssignment(filePath: string): Promise<AssignmentRubric> {
  if (!filePath?.trim()) throw new Error("请指定作业题目文件 assignmentFile");
  const content = await prepareLocalAttachment(filePath);
  if (/\.(md|markdown)$/i.test(filePath) && content[0]?.type === "input_text") {
    const text = content[0].text.slice(content[0].text.indexOf("\n") + 1);
    const rubric = parseMarkdownAssignment(text);
    if (rubric) return validateRubric(rubric);
  }
  return extractAssignment(content);
}

export async function gradeSubmission(
  submissionContent: string | InputContent[],
  assignment: string | AssignmentRubric,
): Promise<GradeResult> {
  const rubric = typeof assignment === "string" ? await extractAssignment(assignment) : validateRubric(assignment);
  const vision = Array.isArray(submissionContent) && submissionContent.some((part) => part.type === "input_image");
  const prompt = SCORING_PROMPT
    .replace("{assignmentDescription}", () => JSON.stringify(rubric.items))
    .replace("{submissionContent}", () => typeof submissionContent === "string" ? submissionContent : "请完整阅读随附的文本和扫描页面。");
  const data = await createResponse({
    instructions: SYSTEM_PROMPT,
    input: typeof submissionContent === "string" ? prompt : [{ role: "user", content: [{ type: "input_text", text: prompt }, ...submissionContent] }],
    temperature: 0,
    text: { format: { type: "json_object" } },
  }, { vision });
  const result = evaluationSchema.parse(parseJson(getResponseText(data.output)));
  const byId = new Map(result.items.map((item) => [item.id, item]));
  if (byId.size !== result.items.length || result.items.length !== rubric.items.length || rubric.items.some((item) => !byId.has(item.id))) {
    throw new Error("LLM 评分计分项缺失、重复或与作业题目不匹配");
  }
  if (result.items.some((item) => item.status === "unreadable")) {
    throw new Error(`提交关键内容无法辨认，需要清晰版本：${result.items.filter((item) => item.status === "unreadable").map((item) => `${item.id}：${item.reason}`).join("；")}`);
  }
  const items = rubric.items.map(({ id }) => {
    const item = byId.get(id)!;
    return { ...item, score: item.status === "complete" ? 10 : 0, maxScore: 10 };
  });
  return { score: items.reduce((sum, item) => sum + item.score, 0), maxScore: items.length * 10, comment: result.comment, items };
}
