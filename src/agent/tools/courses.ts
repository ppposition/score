import { getCourses, getAssignments, getAssignment, getStudents } from "../../api/canvas.js";
import type { Tool, ToolResult } from "../types.js";

export const getAssignmentDetail: Tool = {
  name: "get-assignment-detail",
  description: "获取单个作业的完整描述（含所有 HTML 内容），列表接口的描述可能是截断的",
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
    const a = await getAssignment(courseId, assignmentId);
    const desc = a.description?.replace(/<[^>]+>/g, "").trim() || "(无描述)";
    // 截取前 2000 字符避免输出过长
    const brief = desc.length > 2000 ? desc.slice(0, 2000) + "..." : desc;
    return {
      content: [{ type: "text", text: [
        `作业: ${a.name}`,
        `满分: ${a.points_possible ?? "N/A"}`,
        `截止: ${a.due_at ?? "无"}`,
        `类型: ${a.submission_types?.join(", ") ?? "N/A"}`,
        `描述:\n${brief}`,
      ].join("\n") }],
    };
  },
};

export const listCourses: Tool = {
  name: "list-courses",
  description: "列出当前用户所有 TA/教师 权限的课程",
  parameters: { type: "object", properties: {} },
  handler: async (): Promise<ToolResult> => {
    const courses = await getCourses();
    if (courses.length === 0) {
      return { content: [{ type: "text", text: "没有找到 TA/教师 权限的课程。" }] };
    }
    const lines = courses.map((c) => {
      const term = c.term ? ` (${c.term.name})` : "";
      return `  [${c.id}] ${c.name}${term}`;
    });
    return { content: [{ type: "text", text: `共 ${courses.length} 门课程：\n${lines.join("\n")}` }] };
  },
};

export const listAssignments: Tool = {
  name: "list-assignments",
  description: "列出指定课程的所有作业",
  parameters: {
    type: "object",
    properties: {
      courseId: { type: "number", description: "课程 ID" },
    },
    required: ["courseId"],
  },
  handler: async (args): Promise<ToolResult> => {
    const courseId = Number(args.courseId);
    const assignments = await getAssignments(courseId);
    if (assignments.length === 0) {
      return { content: [{ type: "text", text: "该课程下没有找到作业。" }] };
    }
    const lines = assignments.map((a) => {
      const pending = a.needs_grading_count ? ` (待批改: ${a.needs_grading_count})` : "";
      return `  [${a.id}] ${a.name}  满分: ${a.points_possible ?? "N/A"}${pending}`;
    });
    return { content: [{ type: "text", text: `共 ${assignments.length} 个作业：\n${lines.join("\n")}` }] };
  },
};

export const listStudents: Tool = {
  name: "list-students",
  description: "列出指定课程的所有学生",
  parameters: {
    type: "object",
    properties: {
      courseId: { type: "number", description: "课程 ID" },
    },
    required: ["courseId"],
  },
  handler: async (args): Promise<ToolResult> => {
    const courseId = Number(args.courseId);
    const students = await getStudents(courseId);
    if (students.length === 0) {
      return { content: [{ type: "text", text: "该课程下没有找到学生。" }] };
    }
    const lines = students.map((s) => `  [${s.id}] ${s.name}`);
    return { content: [{ type: "text", text: `共 ${students.length} 名学生：\n${lines.join("\n")}` }] };
  },
};
