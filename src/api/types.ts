import { z } from "zod";

export const AttachmentSchema = z.object({
  id: z.number(),
  display_name: z.string(),
  filename: z.string(),
  url: z.string(),
  "content-type": z.string(),
  size: z.number(),
});

export const SubmissionCommentSchema = z.object({
  id: z.number(),
  author_id: z.number(),
  comment: z.string(),
  created_at: z.string(),
});

export const SubmissionSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  grade: z.string().nullable(),
  score: z.number().nullable(),
  submitted_at: z.string().nullable(),
  late: z.boolean(),
  seconds_late: z.number().nullable().optional(),
  cached_due_date: z.string().nullable().optional(),
  workflow_state: z.string(),
  attachments: z.array(AttachmentSchema).optional().default([]),
  submission_comments: z.array(SubmissionCommentSchema).optional().default([]),
});

export const AssignmentSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  due_at: z.string().nullable(),
  points_possible: z.number().nullable(),
  needs_grading_count: z.number().optional(),
  submission_types: z.array(z.string()).optional(),
  grading_type: z.string().optional(),
});

export const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  sortable_name: z.string().optional(),
});

export const CourseSchema = z.object({
  id: z.number(),
  name: z.string(),
  course_code: z.string().optional(),
  enrollments: z.array(z.object({
    type: z.string(),
    role: z.string(),
    role_id: z.number(),
    user_id: z.number(),
    enrollment_state: z.string(),
  })).optional().default([]),
  access_restricted_by_date: z.boolean().optional(),
  term: z.object({
    id: z.number().optional(),
    name: z.string().optional(),
    start_at: z.string().nullable().optional(),
    end_at: z.string().nullable().optional(),
  }).nullable().optional(),
});

export type Attachment = z.infer<typeof AttachmentSchema>;
export type SubmissionComment = z.infer<typeof SubmissionCommentSchema>;
export type Submission = z.infer<typeof SubmissionSchema>;
export type Assignment = z.infer<typeof AssignmentSchema>;
export type User = z.infer<typeof UserSchema>;
export type Course = z.infer<typeof CourseSchema>;
