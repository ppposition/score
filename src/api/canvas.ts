import "dotenv/config";
import ky from "ky";
import { SubmissionSchema, AssignmentSchema, UserSchema, CourseSchema } from "./types.js";
import type { Submission, Assignment, User, Course } from "./types.js";

const BASE_URL = process.env.CANVAS_BASE_URL!;
const TOKEN = process.env.CANVAS_TOKEN!;

const api = ky.extend({
  prefixUrl: `${BASE_URL}/api/v1`,
  headers: { Authorization: `Bearer ${TOKEN}` },
  retry: 0,
});

async function listAll<T>(
  url: string,
  extraParams: Record<string, string | number> = {},
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  while (true) {
    const data = await api.get(url, {
      searchParams: { per_page: 100, page, ...extraParams },
    }).json<T[]>();
    if (data.length === 0) break;
    results.push(...data);
    page++;
  }
  return results;
}

/** 判断学期是否仍在进行中：end_at 为空或在未来；start_at 为空或已开始 */
function isCurrentTerm(term: Course["term"]): boolean {
  if (!term) return true;
  const now = Date.now();
  if (term.start_at && new Date(term.start_at).getTime() > now) return false;
  if (term.end_at && new Date(term.end_at).getTime() < now) return false;
  return true;
}

export async function getCourses(): Promise<Course[]> {
  // ky 的 URL 字符串会对 [] 做百分号编码，Canvas 不认。只能用 searchParams 数组。
  const results: Course[] = [];
  let page = 1;
  while (true) {
    const data = await api.get("courses", {
      searchParams: [
        ["per_page", 100],
        ["page", page],
        ["include[]", "teachers"],
        ["include[]", "term"],
      ],
    }).json<Record<string, unknown>[]>();
    if (data.length === 0) break;
    results.push(...data.map((c) => CourseSchema.parse(c)));
    page++;
  }
  return results.filter((c) => {
    if (c.access_restricted_by_date) return false;
    const isTAOrTeacher = c.enrollments.some(
      (e) => e.role === "TaEnrollment" || e.role === "TeacherEnrollment",
    );
    if (!isTAOrTeacher) return false;
    return isCurrentTerm(c.term);
  });
}

export async function getAssignments(courseId: number): Promise<Assignment[]> {
  const raw = await listAll(`courses/${courseId}/assignments`);
  return raw.map((a) => AssignmentSchema.parse(a));
}

/** 获取单个作业的完整描述（列表接口的 description 可能是截断的） */
export async function getAssignment(
  courseId: number,
  assignmentId: number,
): Promise<Assignment> {
  const data = await api.get(
    `courses/${courseId}/assignments/${assignmentId}`,
  ).json<Record<string, unknown>>();
  return AssignmentSchema.parse(data);
}

export async function getSubmissions(
  courseId: number,
  assignmentId: number,
): Promise<Submission[]> {
  // include[] 走 searchParams 数组，避免 ky URL 编码问题
  const results: Submission[] = [];
  let page = 1;
  while (true) {
    const data = await api.get(
      `courses/${courseId}/assignments/${assignmentId}/submissions`,
      {
        searchParams: [
          ["per_page", 100],
          ["page", page],
          ["include[]", "submission_comments"],
        ],
      },
    ).json<Record<string, unknown>[]>();
    if (data.length === 0) break;
    results.push(...data.map((s) => SubmissionSchema.parse(s)));
    page++;
  }
  return results;
}

export async function getStudents(courseId: number): Promise<User[]> {
  const raw = await listAll(
    `courses/${courseId}/users?enrollment_type[]=student`,
  );
  return raw.map((u) => UserSchema.parse(u));
}

export async function postGrades(
  courseId: number,
  assignmentId: number,
  grades: Record<number, { posted_grade: number; text_comment?: string }>,
): Promise<void> {
  const body = new URLSearchParams();
  for (const [studentId, grade] of Object.entries(grades)) {
    body.append(`grade_data[${studentId}][posted_grade]`, String(grade.posted_grade));
    if (grade.text_comment) {
      body.append(`grade_data[${studentId}][text_comment]`, grade.text_comment);
    }
  }
  await api.post(
    `courses/${courseId}/assignments/${assignmentId}/submissions/update_grades`,
    { body },
  );
}

/** 下载附件到本地路径，返回文件保存路径 */
export async function downloadAttachment(
  attachmentUrl: string,
  savePath: string,
): Promise<void> {
  const res = await api.get(attachmentUrl);
  const buffer = Buffer.from(await res.arrayBuffer());
  const fs = await import("node:fs/promises");
  await fs.writeFile(savePath, buffer);
}
