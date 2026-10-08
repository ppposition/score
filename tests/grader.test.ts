import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gradeSubmission, loadAssignment, type AssignmentRubric } from "../src/grader/grader.js";
import { parseMarkdownAssignment } from "../src/grader/assignment.js";
import { gradeSingle, gradeAll } from "../src/agent/tools/grading.js";

process.env.LLM_BASE_URL = "https://example.test/v1";
process.env.LLM_API_KEY = "test-key";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const rubric: AssignmentRubric = { items: Array.from({ length: 12 }, (_, i) => ({ id: `题${i + 1}`, requirement: "完成解答" })) };
function reply(value: unknown) {
  return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
}
function evaluations(status = "complete") {
  return { items: rubric.items.map(({ id }) => ({ id, status, reason: "已完成实质解答，即使答案错误" })), comment: "已按完成情况评分" };
}

test("超过100分的作业仍按每项10分求和，忽略模型自行给出的总分", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.instructions, /结论错误.*不扣分/);
    assert.match(body.instructions, /迟交/);
    return reply({ ...evaluations(), score: 7 });
  };
  const result = await gradeSubmission("完整但答案错误的解答", rubric);
  assert.equal(result.score, 120);
  assert.equal(result.maxScore, 120);
  assert.equal(result.items.length, 12);
});

test("缺失、未完成、敷衍计0分，已完成计10分，按题目顺序返回明细", async () => {
  const result = evaluations();
  result.items[0].status = "missing";
  result.items[1].status = "incomplete";
  result.items[2].status = "perfunctory";
  result.items.reverse();
  globalThis.fetch = async () => reply(result);
  const grade = await gradeSubmission("提交", rubric);
  assert.equal(grade.score, 90);
  assert.equal(grade.maxScore, 120);
  assert.deepEqual(grade.items.map((item) => item.id), rubric.items.map((item) => item.id));
  assert.deepEqual(grade.items.slice(0, 4).map((item) => item.score), [0, 0, 0, 10]);
});

test("遗漏、重复、未知项、无效状态及无法辨认均停止评分", async () => {
  const valid = evaluations();
  for (const items of [
    valid.items.slice(1), [...valid.items, valid.items[0]],
    valid.items.map((item, i) => i === 0 ? { ...item, id: "未知题" } : item),
    valid.items.map((item, i) => i === 0 ? { ...item, status: "wrong" } : item),
    valid.items.map((item, i) => i === 0 ? { ...item, status: "unreadable" } : item),
  ]) {
    globalThis.fetch = async () => reply({ ...valid, items });
    await assert.rejects(gradeSubmission("提交", rubric));
  }
});

test("指定本地题目文件用于提取小题清单，空文件及无题目文件拒绝评分", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "assignment-test-"));
  try {
    const file = path.join(dir, "作业.txt");
    const text = "# 第1章\n## 第8题\n1. 求表达式\n2. 判断稳定性\n## 第10题\n计算两个表达式";
    await fs.writeFile(file, text);
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.input[0].content[0].text, `附件：作业.txt\n${text}`);
      assert.match(body.instructions, /不再对父题重复计分/);
      assert.match(body.instructions, /不要把公式中的多个变量/);
      return reply({ items: [
        { id: "第1章第8题(1)", requirement: "求表达式" },
        { id: "第1章第8题(2)", requirement: "判断稳定性" },
        { id: "第1章第10题", requirement: "计算两个表达式" },
      ] });
    };
    assert.equal((await loadAssignment(file)).items.length, 3);
    globalThis.fetch = async () => reply({ items: [] });
    await assert.rejects(loadAssignment(file));
    globalThis.fetch = async () => reply({ items: [rubric.items[0], rubric.items[0]] });
    await assert.rejects(loadAssignment(file), /重复/);
    await fs.writeFile(file, "  ");
    await assert.rejects(loadAssignment(file), /内容为空/);
    await assert.rejects(loadAssignment(path.join(dir, "不存在.md")), /ENOENT/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("单人和批量工具必须先指定题目文件，缺少文件时不访问Canvas或加载附件", async () => {
  globalThis.fetch = async () => { throw new Error("不应请求API"); };
  for (const tool of [gradeSingle, gradeAll]) {
    assert.ok(tool.parameters.required?.includes("assignmentFile"));
    await assert.rejects(tool.handler({ courseId: 1, assignmentId: 2, userId: 3 }), /指定作业题目文件/);
  }
});

test("单人及批量评分先提取文件题目，再加载对应用户附件，批量共用一份清单且dryRun不写回", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "grading-flow-test-"));
  const file = path.join(dir, "题目.txt");
  await fs.writeFile(file, "## 第1题\n给出实质解答");
  let recordPath: string | undefined;
  try {
    for (const tool of [gradeSingle, gradeAll]) {
      const events: string[] = [];
      const users = tool === gradeSingle ? [3] : [3, 4];
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === "example.test") {
          const body = JSON.parse(String(init?.body));
          if (body.instructions.includes("提取全部计分项")) {
            events.push("题目提取");
            assert.match(body.input[0].content[0].text, /给出实质解答/);
            return reply({ items: [{ id: "第1题", requirement: "给出实质解答" }] });
          }
          const user = users[events.filter((event) => event.startsWith("评分")).length];
          assert.match(body.input[0].content[1].text, new RegExp(`用户${user}的解答`));
          events.push(`评分${user}`);
          return reply({ items: [{ id: "第1题", status: "complete", reason: "实质作答完整" }], comment: "已完成" });
        }
        if (url.hostname === "attachment.test") {
          events.push(`附件${url.pathname.slice(1)}`);
          return new Response(`用户${url.pathname.slice(1)}的解答`);
        }
        assert.equal(input instanceof Request ? input.method : init?.method ?? "GET", "GET");
        assert.equal(events[0], "题目提取");
        if (url.searchParams.get("page") === "2") return Response.json([]);
        if (url.pathname.endsWith("/submissions")) {
          return Response.json(users.map((user) => ({
            id: user, user_id: user, grade: null, score: null, submitted_at: "2026-10-08", late: true, seconds_late: 86401, workflow_state: "submitted",
            attachments: [{ id: user, filename: `${user}.md`, display_name: `${user}.md`, size: 1, "content-type": "text/markdown", url: `https://attachment.test/${user}` }],
          })));
        }
        if (url.pathname.endsWith("/assignments/2")) return Response.json({ id: 2, name: "作业", description: null, due_at: "2026-10-06T00:00:00Z", points_possible: 10 });
        if (url.pathname.endsWith("/users")) return Response.json(users.map((id) => ({ id, name: `用户${id}` })));
        throw new Error(`不应请求其他Canvas接口：${url.pathname}`);
      };
      const result = await tool.handler({ courseId: 1, assignmentId: 2, userId: 3, assignmentFile: file, dryRun: true });
      assert.deepEqual(events, ["题目提取", ...users.flatMap((id) => [`附件${id}`, `评分${id}`])]);
      assert.match(result.content[0].text, /0\/10/);
      assert.match(result.content[0].text, /扣20分/);
      if (tool === gradeAll) {
        recordPath = result.content[0].text.match(/评分记录已保存: (.+)/)?.[1];
        assert.ok(recordPath);
        const records = JSON.parse(await fs.readFile(recordPath, "utf-8"));
        assert.equal(records.length, 2);
        assert.equal(records[0].items[0].score, 10);
        assert.equal(records[0].baseScore, 10);
        assert.equal(records[0].latePenalty, 20);
        assert.equal(records[0].lateSeconds, 86401);
        assert.equal(records[0].score, 0);
      }
    }
  } finally {
    if (recordPath) await fs.rm(recordPath, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("项目作业1 Markdown 不调用模型即可稳定提取13项，保留公式和公共题干", async () => {
  globalThis.fetch = async () => { throw new Error("不应调用模型或Canvas"); };
  const result = await loadAssignment(fileURLToPath(new URL("../作业1.md", import.meta.url)));
  assert.deepEqual(result.items.map((item) => item.id), [
    "第1章第3题", "第1章第8题(1)", "第1章第8题(2)", "第1章第8题(3)",
    "第1章第10题", "第1章第11题(1)", "第1章第11题(2)", "第1章第13题",
    "第2章第1题", "第2章第2题(a)", "第2章第2题(b)", "第2章第2题(c)", "第2章第3题",
  ]);
  assert.match(result.items[1].requirement, /x_\{n\+2\}/);
  assert.match(result.items[2].requirement, /x_0\^\* = 1.414/);
  assert.match(result.items[9].requirement, /f\(x\) = e\^x/);
  assert.match(result.items[4].requirement, /判断哪个更准确/);
});

test("Markdown 解析忽略代码和公式中的编号；同章重复题号仍明确报错", () => {
  const text = "## 第 1 章习题\n### 第 3 题\n```text\n1. 代码内容\n### 第 99 题\n```\n$$\n2. 公式内容\n$$\n作答要求";
  assert.deepEqual(parseMarkdownAssignment(text)?.items.map((item) => item.id), ["第1章第3题"]);
  assert.throws(() => parseMarkdownAssignment("## 第1章\n### 第3题\n要求一\n### 第3题\n要求二"), /第1章第3题.*检查章节/);
  assert.equal(parseMarkdownAssignment("# 作业\n普通格式题目"), undefined);
});
