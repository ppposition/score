import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAssignment, getStudents, getSubmissions } from "../../api/canvas.js";
import { loadAssignment } from "../../grader/grader.js";
import { getLatePenalty } from "../../grader/late.js";
import { shouldSkipSubmission } from "../../grader/selection.js";
import { classifyError, positiveInteger } from "../../api/errors.js";
import { runGrader } from "./grader.js";
import { validateGrade } from "./validation.js";
import { prepareSchema, delegateSchema, finalizeSchema, type GradingBatch, type GradingTask } from "./types.js";

export interface SubagentSettings { concurrency: number; taskTimeoutMs: number; maxAttempts: number }
export function readSubagentSettings(): SubagentSettings {
  positiveInteger("LLM_REQUEST_TIMEOUT_MS", 120000);
  return { concurrency: positiveInteger("SUBAGENT_MAX_CONCURRENCY", 3, 8),
    taskTimeoutMs: positiveInteger("SUBAGENT_TASK_TIMEOUT_MS", 300000),
    maxAttempts: positiveInteger("SUBAGENT_MAX_ATTEMPTS", 2, 3) };
}
const defaults = { getAssignment, getStudents, getSubmissions, loadAssignment, runGrader,
  wait: (ms: number) => delay(ms), outputDir: "output", log: (message: string) => console.log(message) };
type Dependencies = typeof defaults;

/** 所有批次共享队列；每个 slot 包含完整子 agent、附件处理及清理。 */
export class GradingBatchManager {
  private batches = new Map<string, GradingBatch>();
  private inflight = new Map<string, Promise<void>>();
  private locks = new Map<string, Promise<unknown>>();
  private queue: (() => Promise<void>)[] = [];
  private active = 0;
  private deps: Dependencies;
  constructor(private settings = readSubagentSettings(), dependencies: Partial<Dependencies> = {}) {
    if (!Number.isInteger(settings.concurrency) || settings.concurrency < 1 || settings.concurrency > 8 || !Number.isSafeInteger(settings.taskTimeoutMs) || settings.taskTimeoutMs < 1 || !Number.isInteger(settings.maxAttempts) || settings.maxAttempts < 1 || settings.maxAttempts > 3) throw new Error("无效 subagent 配置");
    this.deps = { ...defaults, ...dependencies };
  }
  progress() {
    return [...this.batches.values()].map((batch) => ({ batchId: batch.batchId, status: batch.status,
      progress: this.counts(batch), unfinishedUserIds: [...batch.tasks.values()]
        .filter((task) => task.status === "pending" || task.status === "running").map((task) => task.userId) }));
  }
  clear(): void {
    if (this.inflight.size) throw new Error("仍有在途评分任务，不能清空批次");
    this.batches.clear();
  }
  private batch(id: string): GradingBatch {
    const batch = this.batches.get(id);
    if (!batch) throw new Error(`批次不存在或已清空：${id}`);
    return batch;
  }
  private async locked<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push(async () => { try { await fn(); resolve(); } catch (error) { reject(error); } });
    });
    this.pump();
    return promise;
  }
  private pump(): void {
    while (this.active < this.settings.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void job().finally(() => { this.active--; this.pump(); });
    }
  }
  async prepare(input: unknown) {
    const args = prepareSchema.parse(input);
    const rubric = structuredClone(await this.deps.loadAssignment(args.assignmentFile));
    const [submissions, students] = await Promise.all([
      this.deps.getSubmissions(args.courseId, args.assignmentId), this.deps.getStudents(args.courseId),
    ]);
    const snapshot = new Map(submissions.map((sub) => [sub.user_id, structuredClone(sub)]));
    if (snapshot.size !== submissions.length) throw new Error("提交列表包含重复学生 ID");
    for (const id of args.userIds ?? []) if (!snapshot.has(id)) throw new Error(`学生 ${id} 不属于本作业提交范围`);
    const selected = args.userIds ? args.userIds.map((id) => snapshot.get(id)!) : [...snapshot.values()];
    const skipped: GradingBatch["skipped"] = [];
    const eligible = selected.filter((sub) => {
      const reason = !["submitted", "graded"].includes(sub.workflow_state) ? "尚未提交" : shouldSkipSubmission(sub) ? "该提交已评分" : undefined;
      if (reason) { skipped.push({ userId: sub.user_id, reason }); return false; }
      return true;
    });
    const assignment = eligible.some((sub) => sub.late && sub.seconds_late == null && sub.cached_due_date === undefined)
      ? await this.deps.getAssignment(args.courseId, args.assignmentId) : undefined;
    for (const sub of eligible) getLatePenalty({ ...sub, dueAt: assignment?.due_at });
    const batch: GradingBatch = {
      ...args, batchId: randomUUID(), rubric, status: "prepared", createdAt: new Date().toISOString(),
      submissions: snapshot, studentNames: new Map(students.map((s) => [s.id, s.name])), dueAt: assignment?.due_at,
      tasks: new Map(eligible.map((sub) => [sub.user_id, { taskId: randomUUID(), userId: sub.user_id, status: "pending", attempts: 0 }])),
      skipped, revision: 0,
    };
    this.batches.set(batch.batchId, batch);
    this.deps.log(`[batch ${batch.batchId}] prepared: eligible=${eligible.length} skipped=${skipped.length} concurrency=${this.settings.concurrency}`);
    return { batchId: batch.batchId, courseId: batch.courseId, assignmentId: batch.assignmentId,
      rubricItemCount: rubric.items.length, maxScore: rubric.items.length * 10,
      eligibleStudents: eligible.map((sub) => ({ userId: sub.user_id, name: batch.studentNames.get(sub.user_id) ?? `user_${sub.user_id}` })),
      skipped, concurrencyLimit: this.settings.concurrency };
  }
  private counts(batch: GradingBatch) {
    const counts = { pending: 0, running: 0, succeeded: 0, failed: 0 };
    for (const task of batch.tasks.values()) counts[task.status]++;
    return counts;
  }
  private taskSummary(task: GradingTask) {
    return { taskId: task.taskId, userId: task.userId, status: task.status, attempts: task.attempts,
      ...(task.result ? { score: task.result.score, maxScore: task.result.maxScore } : {}),
      ...(task.error ? { error: task.error } : {}) };
  }
  async delegate(input: unknown) {
    const args = delegateSchema.parse(input);
    const batch = this.batch(args.batchId);
    // 锁只覆盖验证与入队，不覆盖等待；重复委派可以复用同一 Promise。
    const { promises } = await this.locked(batch.batchId, () => {
      for (const id of args.userIds) if (!batch.tasks.has(id)) throw new Error(`学生 ${id} 不属于批次待评分范围`);
      const promises: Promise<void>[] = [];
      for (const id of args.userIds) {
        const task = batch.tasks.get(id)!;
        const existing = this.inflight.get(task.taskId);
        if (existing) { promises.push(existing); continue; }
        if (task.status === "succeeded") continue;
        if (task.status === "failed" && (!args.retryFailed || !task.error?.retryable || task.attempts >= this.settings.maxAttempts)) continue;
        task.status = "running";
        batch.status = "running";
        batch.revision++;
        const promise = this.enqueue(() => this.execute(batch, task)).finally(() => this.inflight.delete(task.taskId));
        this.inflight.set(task.taskId, promise);
        promises.push(promise);
      }
      return { promises };
    });
    await Promise.all(promises);
    return { batchId: batch.batchId, results: args.userIds.map((id) => this.taskSummary(batch.tasks.get(id)!)), progress: this.counts(batch) };
  }
  private async execute(batch: GradingBatch, task: GradingTask): Promise<void> {
    // 每次委派最多自动运行两次，但累计仍受 maxAttempts 限制。
    const automaticLimit = Math.min(this.settings.maxAttempts, task.attempts + 2);
    do {
      task.attempts++;
      task.startedAt = new Date().toISOString();
      task.finishedAt = undefined;
      task.error = undefined;
      task.result = undefined;
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("评分任务超时", "TimeoutError")), this.settings.taskTimeoutMs);
      this.deps.log(`[batch ${batch.batchId}] [task ${task.taskId}] user=${task.userId} running attempt=${task.attempts}`);
      try {
        const result = await this.deps.runGrader(batch, task, controller.signal);
        controller.signal.throwIfAborted();
        task.result = validateGrade(result, batch, task.userId);
        task.status = "succeeded";
      } catch (error) {
        task.error = classifyError(error, controller.signal);
        task.status = "failed";
      } finally {
        clearTimeout(timer);
        task.finishedAt = new Date().toISOString();
        batch.revision++;
      }
      this.deps.log(`[batch ${batch.batchId}] [task ${task.taskId}] user=${task.userId} ${task.status} attempt=${task.attempts} ${task.result ? `score=${task.result.score} maxScore=${task.result.maxScore}` : `code=${task.error?.code}`} elapsedMs=${Date.now() - started}`);
      if (task.status === "succeeded" || !task.error?.retryable || task.attempts >= automaticLimit) break;
      const waitMs = task.error.retryAfterMs ?? 250 * 2 ** (task.attempts - 1) + Math.random() * 100;
      // 退避也属于本次在途任务，防止 finalize 与重试发生竞争。
      task.status = "running";
      await this.deps.wait(waitMs);
    } while (task.attempts < automaticLimit);
  }
  async finalize(input: unknown) {
    const args = finalizeSchema.parse(input);
    const batch = this.batch(args.batchId);
    return this.locked(batch.batchId, async () => {
      const unfinished = [...batch.tasks.values()].filter((t) => t.status === "pending" || t.status === "running");
      if (unfinished.length) throw new Error(`批次未完成，未完成学生 ID：${unfinished.map((t) => t.userId).join(", ")}`);
      const records = [...batch.tasks.values()].filter((t) => t.status === "succeeded").map((task) => ({ ...validateGrade(task.result, batch, task.userId), userId: task.userId }));
      const progress = this.counts(batch);
      const status = progress.failed ? progress.succeeded ? "partial" : "failed" : "completed";
      const recordFile = path.join(this.deps.outputDir, `grading_records_${batch.assignmentId}_${batch.batchId}.json`);
      const manifestFile = path.join(this.deps.outputDir, `grading_batch_${batch.assignmentId}_${batch.batchId}.json`);
      if (batch.savedRevision !== batch.revision) {
        await fs.mkdir(this.deps.outputDir, { recursive: true });
        await this.atomicWrite(recordFile, records);
        await this.atomicWrite(manifestFile, { batchId: batch.batchId, courseId: batch.courseId,
          assignmentId: batch.assignmentId, assignmentFile: batch.assignmentFile, createdAt: batch.createdAt,
          status, progress, tasks: [...batch.tasks.values()].map(({ result, ...task }) => task), skipped: batch.skipped,
          recordFile, manifestFile });
        batch.status = status;
        batch.recordFile = recordFile;
        batch.manifestFile = manifestFile;
        batch.savedRevision = batch.revision;
        this.deps.log(`[batch ${batch.batchId}] finalized: succeeded=${progress.succeeded} failed=${progress.failed} records=${recordFile}`);
      }
      return { batchId: batch.batchId, status, progress, recordFile, manifestFile, skipped: batch.skipped,
        results: [...batch.tasks.values()].map((task) => this.taskSummary(task)) };
    });
  }
  private async atomicWrite(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2));
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
