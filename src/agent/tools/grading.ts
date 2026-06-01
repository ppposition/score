import fs from "node:fs/promises";
import {
  getSubmissions,
  getAssignments,
  getStudents,
  postGrades,
} from "../../api/canvas.js";
import { gradeSubmission } from "../../grader/grader.js";
import type { GradeResult } from "../../grader/grader.js";
import type { Tool, ToolResult } from "../types.js";

/** 提取附件文本内容 */
async function fetchAttachmentText(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.CANVAS_TOKEN}` },
  });
  return resp.text();
}

export const gradeSingle: Tool = {
  name: "grade-submission",
  description: "对单个学生提交进行 LLM 评分",
  parameters: {
    type: "object",
    properties: {
      courseId: { type: "number", description: "课程 ID" },
      assignmentId: { type: "number", description: "作业 ID" },
      userId: { type: "number", description: "学生用户 ID" },
    },
    required: ["courseId", "assignmentId", "userId"],
  },
  handler: async (args): Promise<ToolResult> => {
    const courseId = Number(args.courseId);
    const assignmentId = Number(args.assignmentId);
    const userId = Number(args.userId);

    const [assignments, subs] = await Promise.all([
      getAssignments(courseId),
      getSubmissions(courseId, assignmentId),
    ]);
    const assignment = assignments.find((a) => a.id === assignmentId);
    const sub = subs.find((s) => s.user_id === userId);
    if (!sub) return { content: [{ type: "text", text: `未找到 user_id=${userId} 的提交。` }], isError: true };

    let content = "";
    for (const att of sub.attachments) {
      content += (await fetchAttachmentText(att.url)) + "\n";
    }
    if (!content) content = "(无附件内容)";

    const record = await gradeSubmission(content, assignment?.description ?? "");
    return {
      content: [{ type: "text", text: `评分完成：分数 ${record.score}/100\n评语：${record.comment}` }],
    };
  },
};

export const gradeAll: Tool = {
  name: "grade-all",
  description: "对某作业的所有已提交学生进行 LLM 评分",
  parameters: {
    type: "object",
    properties: {
      courseId: { type: "number", description: "课程 ID" },
      assignmentId: { type: "number", description: "作业 ID" },
      dryRun: { type: "boolean", description: "仅评分不回写 Canvas" },
    },
    required: ["courseId", "assignmentId"],
  },
  handler: async (args): Promise<ToolResult> => {
    const courseId = Number(args.courseId);
    const assignmentId = Number(args.assignmentId);
    const dryRun = Boolean(args.dryRun);

    const [assignments, subs, students] = await Promise.all([
      getAssignments(courseId),
      getSubmissions(courseId, assignmentId),
      getStudents(courseId),
    ]);
    const assignment = assignments.find((a) => a.id === assignmentId);
    const studentMap = new Map(students.map((s) => [s.id, s.name]));
    const description = assignment?.description ?? "";

    const grades: Record<number, { posted_grade: number; text_comment?: string }> = {};
    const records: GradeResult[] = [];
    const logs: string[] = [];

    for (const sub of subs) {
      if (sub.workflow_state !== "submitted" && sub.workflow_state !== "graded") continue;
      const name = studentMap.get(sub.user_id) ?? `user_${sub.user_id}`;
      logs.push(`  评分 [${sub.user_id}] ${name}...`);

      let content = "";
      for (const att of sub.attachments) {
        content += (await fetchAttachmentText(att.url)) + "\n";
      }
      if (!content) content = "(无附件内容)";

      const record = await gradeSubmission(content, description);
      records.push(record);
      logs.push(`    -> ${record.score}/100 ${record.comment}`);
      grades[sub.user_id] = { posted_grade: record.score, text_comment: record.comment };
    }

    // 保存评分记录
    const recordPath = `grading_records_${assignmentId}_${Date.now()}.json`;
    await fs.writeFile(recordPath, JSON.stringify(records, null, 2));
    logs.push(`\n评分记录已保存: ${recordPath}`);

    if (!dryRun && Object.keys(grades).length > 0) {
      await postGrades(courseId, assignmentId, grades);
      logs.push("分数已写回 Canvas");
    }

    return { content: [{ type: "text", text: logs.join("\n") }] };
  },
};

export const postGradesTool: Tool = {
  name: "post-grades",
  description: "将评分结果写回 Canvas（需先运行 grade-all 获得评分记录文件）",
  parameters: {
    type: "object",
    properties: {
      courseId: { type: "number", description: "课程 ID" },
      assignmentId: { type: "number", description: "作业 ID" },
      recordFile: { type: "string", description: "评分记录 JSON 文件路径" },
    },
    required: ["courseId", "assignmentId", "recordFile"],
  },
  handler: async (args): Promise<ToolResult> => {
    const courseId = Number(args.courseId);
    const assignmentId = Number(args.assignmentId);
    const recordFile = String(args.recordFile);

    const raw = await fs.readFile(recordFile, "utf-8");
    const records: GradeResult[] = JSON.parse(raw);
    const grades: Record<number, { posted_grade: number; text_comment?: string }> = {};
    // 从 records 文件重建 grades — 这里假设 records 按 sub.user_id 顺序存储
    // 需要重新获取 submissions 来匹配 user_id
    const subs = await getSubmissions(courseId, assignmentId);
    const submitted = subs.filter(
      (s) => s.workflow_state === "submitted" || s.workflow_state === "graded",
    );
    for (let i = 0; i < submitted.length && i < records.length; i++) {
      grades[submitted[i].user_id] = {
        posted_grade: records[i].score,
        text_comment: records[i].comment,
      };
    }
    await postGrades(courseId, assignmentId, grades);
    return { content: [{ type: "text", text: `已写回 ${Object.keys(grades).length} 个评分到 Canvas。` }] };
  },
};
