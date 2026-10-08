import { Command } from "commander";
import { getCourses, getAssignments, getSubmissions, getStudents, downloadAttachment } from "../api/canvas.js";
import { runAgent } from "../agent/repl.js";
import { runGradingAgent } from "../agent/grade.js";
import fs from "node:fs/promises";
import path from "node:path";

const program = new Command();

program
  .name("canvas-grader")
  .description("Canvas LMS 自动打分工具");

program
  .command("agent")
  .description("进入交互式 Agent 模式（推荐）")
  .action(() => runAgent());

program
  .command("list")
  .description("列出 TA 课程，或列出某课程的所有作业")
  .option("-c, --course <id>", "课程 ID（不填则列出所有 TA 课程）", parseInt)
  .action(async (opts) => {
    if (opts.course) {
      const assignments = await getAssignments(opts.course);
      for (const a of assignments) {
        console.log(`[${a.id}] ${a.name}  (满分: ${a.points_possible ?? "N/A"})`);
      }
    } else {
      const courses = await getCourses();
      for (const c of courses) {
        const term = c.term ? ` (${c.term.name})` : "";
        console.log(`[${c.id}] ${c.name}${term}`);
      }
    }
  });

program
  .command("download")
  .description("下载某作业的所有学生提交附件")
  .requiredOption("-c, --course <id>", "课程 ID", parseInt)
  .requiredOption("-a, --assignment <id>", "作业 ID", parseInt)
  .option("-o, --out <dir>", "输出目录", "./submissions")
  .action(async (opts) => {
    const students = await getStudents(opts.course);
    const studentMap = new Map(students.map((s) => [s.id, s.name]));

    const subs = await getSubmissions(opts.course, opts.assignment);
    await fs.mkdir(opts.out, { recursive: true });

    for (const sub of subs) {
      const name = studentMap.get(sub.user_id) || `unknown_${sub.user_id}`;
      const state = sub.late ? "迟交" : sub.submitted_at ? "已提交" : "未提交";
      console.log(`${name}: ${state} (${sub.attachments.length} 个附件)`);

      for (const att of sub.attachments) {
        const savePath = path.join(opts.out, `${name}_${att.filename}`);
        await downloadAttachment(att.url, savePath);
        console.log(`  -> ${savePath}`);
      }
    }
  });

program
  .command("grade")
  .description("通过主 Agent 和评分 subagent 对某作业的所有提交评分")
  .requiredOption("-c, --course <id>", "课程 ID", parseInt)
  .requiredOption("-a, --assignment <id>", "作业 ID", parseInt)
  .requiredOption("-f, --assignment-file <path>", "作业题目文件（MD、TXT、PDF 等）")
  .option("--dry-run", "仅评分不回写 Canvas")
  .option("--include-full-score-comment", "满分也提交评语（覆盖环境设置）")
  .action((opts) => runGradingAgent(opts));

program.parseAsync().catch((error: Error) => {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
});
