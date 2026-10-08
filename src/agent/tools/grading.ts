import fs from "node:fs/promises";
import path from "node:path";
import {
  getSubmissions,
  getStudents,
  postGrades,
} from "../../api/canvas.js";
import { gradeSubmission, loadAssignment } from "../../grader/grader.js";
import type { GradeResult } from "../../grader/grader.js";
import type { Tool, ToolResult } from "../types.js";
import { prepareAttachments } from "../../grader/attachments.js";
import { toCanvasGrade } from "../../grader/posting.js";

export const gradeSingle: Tool = {
  name: "grade-submission",
  description: "对单个学生提交进行 LLM 评分",
  parameters: {
    type: "object",
    properties: {
      courseId: { type: "number", description: "课程 ID" },
      assignmentId: { type: "number", description: "作业 ID" },
      assignmentFile: { type: "string", description: "本地作业题目文件路径（先读取题目，再加载学生附件评分）" },
      userId: { type: "number", description: "学生用户 ID" },
    },
    required: ["courseId", "assignmentId", "userId", "assignmentFile"],
  },
  handler: async (args): Promise<ToolResult> => {
    const courseId = Number(args.courseId);
    const assignmentId = Number(args.assignmentId);
    const userId = Number(args.userId);

    const rubric = await loadAssignment(typeof args.assignmentFile === "string" ? args.assignmentFile : "");
    const subs = await getSubmissions(courseId, assignmentId);
    const sub = subs.find((s) => s.user_id === userId);
    if (!sub) return { content: [{ type: "text", text: `未找到 user_id=${userId} 的提交。` }], isError: true };

    const content = await prepareAttachments(sub.attachments);

    const record = await gradeSubmission(content, rubric);
    return {
      content: [{ type: "text", text: `评分完成：分数 ${record.score}/${record.maxScore}\n评语：${record.comment}` }],
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
      assignmentFile: { type: "string", description: "本地作业题目文件路径（先读取题目，再加载学生附件评分）" },
      dryRun: { type: "boolean", description: "仅评分不回写 Canvas" },
      skipFullScoreComment: { type: "boolean", description: "满分时只提交分数、不提交评语，默认开启；false 表示满分也提交评语" },
    },
    required: ["courseId", "assignmentId", "assignmentFile"],
  },
  handler: async (args): Promise<ToolResult> => {
    const courseId = Number(args.courseId);
    const assignmentId = Number(args.assignmentId);
    const dryRun = Boolean(args.dryRun);

    const rubric = await loadAssignment(typeof args.assignmentFile === "string" ? args.assignmentFile : "");
    const [subs, students] = await Promise.all([
      getSubmissions(courseId, assignmentId),
      getStudents(courseId),
    ]);
    const studentMap = new Map(students.map((s) => [s.id, s.name]));

    const grades: Record<number, { posted_grade: number; text_comment?: string }> = {};
    const records: GradeResult[] = [];
    const logs: string[] = [];

    for (const sub of subs) {
      if (sub.workflow_state !== "submitted" && sub.workflow_state !== "graded") continue;
      const name = studentMap.get(sub.user_id) ?? `user_${sub.user_id}`;
      logs.push(`  评分 [${sub.user_id}] ${name}...`);

      const content = await prepareAttachments(sub.attachments);

      const record = await gradeSubmission(content, rubric);
      records.push(record);
      logs.push(`    -> ${record.score}/${record.maxScore} ${record.comment}`);
      grades[sub.user_id] = toCanvasGrade(record, typeof args.skipFullScoreComment === "boolean" ? args.skipFullScoreComment : undefined);
    }

    // 保存评分记录
    await fs.mkdir("output", { recursive: true });
    const recordPath = path.join("output", `grading_records_${assignmentId}_${Date.now()}.json`);
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
      skipFullScoreComment: { type: "boolean", description: "满分时只提交分数、不提交评语，默认开启；false 表示满分也提交评语" },
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
      grades[submitted[i].user_id] = toCanvasGrade(records[i], typeof args.skipFullScoreComment === "boolean" ? args.skipFullScoreComment : undefined);
    }
    await postGrades(courseId, assignmentId, grades);
    return { content: [{ type: "text", text: `已写回 ${Object.keys(grades).length} 个评分到 Canvas。` }] };
  },
};
