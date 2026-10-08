import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createAgentContext, runMainAgent } from "./main.js";
import type { ChatMessage, AgentExecutionContext } from "./types.js";
import type { InputContent } from "../api/llm.js";
import { prepareLocalAttachment } from "../grader/attachments.js";

/** 交互式 Agent —— 自然语言驱动，LLM 自动选择工具 */
export async function runAgent(): Promise<void> {
  const ctx: AgentExecutionContext = createAgentContext();
  const rl = readline.createInterface({ input, output });

  console.log(`
╔══════════════════════════════════════════╗
║        Canvas Auto-Grading Agent         ║
║      🤖 用自然语言与我对话，我来调工具     ║
╚══════════════════════════════════════════╝`);
  console.log("你可以说「列出我的课程」「给作业打分」「查看提交状态」等。输入 exit 退出。\n");

  const messages: ChatMessage[] = [];
  const pendingAttachments: InputContent[] = [];

  while (true) {
    const ctxHint = [
      ctx.currentCourseId ? `课程 ${ctx.currentCourseId}` : "",
      ctx.currentAssignmentId ? `作业 ${ctx.currentAssignmentId}` : "",
    ].filter(Boolean).join(" / ");
    const prompt = ctxHint ? `agent (${ctxHint}) > ` : "agent > ";

    const line = await rl.question(prompt);
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === "exit" || trimmed === "quit") break;

    // 内置命令
    if (trimmed.startsWith("/")) {
      const parts = trimmed.slice(1).split(/\s+/);
      switch (parts[0]) {
        case "course":
          ctx.currentCourseId = Number(parts[1]);
          console.log(`✅ 当前课程已设为 [${ctx.currentCourseId}]`);
          break;
        case "assignment":
          ctx.currentAssignmentId = Number(parts[1]);
          console.log(`✅ 当前作业已设为 [${ctx.currentAssignmentId}]`);
          break;
        case "status":
          console.log(`📋 当前上下文：
  课程 ID: ${ctx.currentCourseId ?? "未设置"}
  作业 ID: ${ctx.currentAssignmentId ?? "未设置"}`);
          break;
        case "clear":
          try { ctx.batchManager!.clear(); } catch (error) {
            console.error((error as Error).message);
            break;
          }
          messages.length = 0;
          pendingAttachments.length = 0;
          console.log("✅ 对话历史已清空");
          break;
        case "attach": {
          let filePath = trimmed.replace(/^\/attach\s*/, "").trim();
          if ((filePath.startsWith('"') && filePath.endsWith('"')) || (filePath.startsWith("'") && filePath.endsWith("'"))) filePath = filePath.slice(1, -1);
          if (!filePath) {
            console.log("用法：/attach <本地 PDF 或 MD 文件路径>");
            break;
          }
          try {
            const content = await prepareLocalAttachment(filePath);
            const pageCount = [...pendingAttachments, ...content].filter((part) => part.type === "input_image").length;
            if (pageCount > 30) throw new Error("待发送 PDF 总页数超过 30 页，请先发送已有附件");
            pendingAttachments.push(...content);
            console.log(`✅ 附件已加载：${filePath}，将在下一条消息中发送`);
          } catch (err: any) {
            console.error(`附件加载失败：${err.message}`);
          }
          break;
        }
        case "help":
          console.log(`可用命令：
  /course <id>      设置当前课程
  /assignment <id>  设置当前作业
  /attach <path>    加载本地 PDF、MD 或文本附件（可重复添加）
  /status           查看当前上下文
  /clear            清空对话历史
  exit / quit       退出 Agent`);
          break;
        default:
          console.log(`未知命令 /${parts[0]}，输入 /help 查看可用命令`);
      }
      continue;
    }

    // 正常对话流程
    messages.push({
      role: "user", content: trimmed,
      ...(pendingAttachments.length ? { input_content: [{ type: "input_text" as const, text: trimmed }, ...pendingAttachments] } : {}),
    });
    pendingAttachments.length = 0;

    const result = await runMainAgent(messages, ctx);
    if (result.status === "completed") console.log(`\n${result.finalText ?? ""}\n`);
    else {
      console.error(`\n❌ ${result.error?.message ?? "任务未完成"}`);
      const batches = ctx.batchManager!.progress();
      if (batches.length) console.error(`批次进度：${JSON.stringify(batches)}；可继续委派或汇总。`);
    }

  }

  rl.close();
  console.log("Agent 已退出。");
}
