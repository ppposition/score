import path from "node:path";
import fs from "node:fs/promises";
import {
  getSubmissions,
  getStudents,
  downloadAttachment,
} from "../../api/canvas.js";
import type { Tool, ToolResult } from "../types.js";

export const listSubmissions: Tool = {
  name: "list-submissions",
  description: "查看某作业的所有学生提交状态",
  parameters: {
    type: "object",
    properties: {
      courseId: { type: "number", description: "课程 ID" },
      assignmentId: { type: "number", description: "作业 ID" },
    },
    required: ["courseId", "assignmentId"],
  },
  handler: async (args): Promise<ToolResult> => {
    const courseId = Number(args.courseId);
    const assignmentId = Number(args.assignmentId);
    const [subs, students] = await Promise.all([
      getSubmissions(courseId, assignmentId),
      getStudents(courseId),
    ]);
    const studentMap = new Map(students.map((s) => [s.id, s.name]));
    const lines = subs.map((s) => {
      const name = studentMap.get(s.user_id) ?? `unknown_${s.user_id}`;
      const status = s.late ? "⏰ 迟交" : s.submitted_at ? "✅ 已提交" : "❌ 未提交";
      const files = s.attachments.length > 0 ? ` (${s.attachments.length} 个附件)` : "";
      return `  [${s.user_id}] ${name}: ${status}${files}`;
    });
    return {
      content: [{ type: "text", text: `共 ${subs.length} 条提交：\n${lines.join("\n")}` }],
    };
  },
};

export const downloadSubmissions: Tool = {
  name: "download-submissions",
  description: "下载某作业的所有学生提交附件到本地目录",
  parameters: {
    type: "object",
    properties: {
      courseId: { type: "number", description: "课程 ID" },
      assignmentId: { type: "number", description: "作业 ID" },
      outDir: { type: "string", description: "输出目录（默认 ./submissions）" },
    },
    required: ["courseId", "assignmentId"],
  },
  handler: async (args): Promise<ToolResult> => {
    const courseId = Number(args.courseId);
    const assignmentId = Number(args.assignmentId);
    const outDir = String(args.outDir ?? "./submissions");
    const [subs, students] = await Promise.all([
      getSubmissions(courseId, assignmentId),
      getStudents(courseId),
    ]);
    const studentMap = new Map(students.map((s) => [s.id, s.name]));
    await fs.mkdir(outDir, { recursive: true });
    const logs: string[] = [];
    for (const sub of subs) {
      const name = studentMap.get(sub.user_id) ?? `unknown_${sub.user_id}`;
      for (const att of sub.attachments) {
        const savePath = path.join(outDir, `${name}_${att.filename}`);
        await downloadAttachment(att.url, savePath);
        logs.push(`  ${name} -> ${savePath}`);
      }
    }
    return {
      content: [{ type: "text", text: logs.length > 0 ? `下载完成：\n${logs.join("\n")}` : "没有找到附件。" }],
    };
  },
};
