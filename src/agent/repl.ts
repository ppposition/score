import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getTool } from "./registry.js";
import { chat } from "./llm.js";
import type { ChatMessage, SessionContext } from "./types.js";
import type { InputContent } from "../api/llm.js";
import { prepareLocalAttachment } from "../grader/attachments.js";

/** 执行 LLM 返回的 tool_calls */
async function executeToolCalls(msg: ChatMessage, ctx: SessionContext): Promise<ChatMessage[]> {
  if (!msg.tool_calls) return [];

  const results: ChatMessage[] = [];
  for (const tc of msg.tool_calls) {
    const tool = getTool(tc.function.name);
    if (!tool) {
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `未知工具: ${tc.function.name}`,
      });
      continue;
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      args = {};
    }
    // 自动注入上下文中的参数
    if (ctx.currentCourseId && !args.courseId) args.courseId = ctx.currentCourseId;
    if (ctx.currentAssignmentId && !args.assignmentId) args.assignmentId = ctx.currentAssignmentId;

    try {
      const result = await tool.handler(args);
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.content.map((c) => c.text).join("\n"),
      });
    } catch (err: any) {
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `工具执行出错: ${err.message}`,
      });
    }
  }
  return results;
}

/** 交互式 Agent —— 自然语言驱动，LLM 自动选择工具 */
export async function runAgent(): Promise<void> {
  const ctx: SessionContext = {};
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

    let turn = 0;
    while (turn < 10) {
      turn++;
      let reply: ChatMessage;
      try {
        reply = await chat(messages);
      } catch (err: any) {
        console.error(`\n❌ LLM 调用失败: ${err.message}`);
        break;
      }

      if (reply.tool_calls && reply.tool_calls.length > 0) {
        // 执行工具，结果加入消息历史
        const toolResults = await executeToolCalls(reply, ctx);
        messages.push(reply);
        messages.push(...toolResults);
      } else {
        // LLM 直接回复用户
        messages.push(reply);
        console.log(`\n${reply.content ?? ""}\n`);
        break;
      }
    }

    if (turn >= 10) {
      console.log("⚠️ 工具调用次数过多，请简化你的请求。");
    }
  }

  rl.close();
  console.log("Agent 已退出。");
}
