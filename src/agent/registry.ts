import type { Tool } from "./types.js";
import { listCourses, listAssignments, getAssignmentDetail, listStudents } from "./tools/courses.js";
import { listSubmissions, downloadSubmissions } from "./tools/submissions.js";
import { gradeSingle, gradeAll, postGradesTool } from "./tools/grading.js";

/** 所有工具列表 */
const ALL_TOOLS: Tool[] = [
  listCourses,
  listAssignments,
  getAssignmentDetail,
  listStudents,
  listSubmissions,
  downloadSubmissions,
  gradeSingle,
  gradeAll,
  postGradesTool,
];

/** 工具名称 -> Tool 的映射 */
const toolMap = new Map<string, Tool>(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return toolMap.get(name);
}

export function getAllTools(): Tool[] {
  return ALL_TOOLS;
}

/** 生成工具列表的帮助文本 */
export function getToolsHelpText(): string {
  return ALL_TOOLS
    .map((t) => `  ${t.name.padEnd(22)} ${t.description}`)
    .join("\n");
}

/** 列出工具名列表 */
export function getToolNames(): string[] {
  return ALL_TOOLS.map((t) => t.name);
}
