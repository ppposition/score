import "dotenv/config";
import { SYSTEM_PROMPT, SCORING_PROMPT } from "./prompts.js";

export interface GradeResult {
  score: number;
  comment: string;
}

const LLM_BASE = process.env.LLM_BASE_URL!;
const LLM_KEY = process.env.LLM_API_KEY!;
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o";

export async function gradeSubmission(
  submissionContent: string,
  assignmentDescription: string,
): Promise<GradeResult> {
  const prompt = SCORING_PROMPT
    .replace("{assignmentDescription}", assignmentDescription)
    .replace("{submissionContent}", submissionContent);

  const response = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    }),
  });

  const data = await response.json() as any;
  const raw = data.choices?.[0]?.message?.content || "";

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  return jsonMatch
    ? JSON.parse(jsonMatch[0])
    : { score: 0, comment: "解析 LLM 输出失败" };
}
