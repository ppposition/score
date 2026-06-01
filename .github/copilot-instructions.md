# Canvas Auto-Grading Agent — 项目指南

## 项目概述
基于 Canvas LMS API 构建的大模型 Agent 作业评分系统。核心流程：拉取学生提交 → 解析附件 → 调用 LLM 评分 → 写回 Canvas。

API 参考文档：[canvas_submissions_api.md](../canvas_submissions_api.md)

## 技术栈
- **语言**: TypeScript（Node.js 18+）
- **运行时**: `tsx` 或 `ts-node` 直接执行
- **LLM 调用**: 通过 OpenAI 兼容接口（支持多 provider）；Prompt 模板化，分离评分逻辑与系统指令
- **HTTP 客户端**: `ky` 或原生 `fetch`；所有 Canvas API 调用走分页逻辑（`per_page=100`）
- **配置管理**: `.env` 文件 + `dotenv`；TOKEN / BASE_URL / LLM_API_KEY 等敏感信息不入库
- **CLI 框架**: `commander` 或 `yargs`，提供 `grade`, `download`, `list` 等子命令
- **类型校验**: `zod` 定义 API 响应 schema，运行时验证 + 类型推导

## 架构约定
- `src/api/` — Canvas API 封装（分页、鉴权、submission/assignment/user 端点）
- `src/grader/` — LLM 评分核心（prompt 模板、调用策略、结果解析）
- `src/cli/` — 命令行入口
- 单一职责：API 层不做评分逻辑，grader 层不直接调 Canvas API

## 编码原则
- **简洁至上**：代码能少写就少写，不要废话注释，不要冗余中间变量
- **禁止过度防御**：只处理实际会发生的错误，不要为"万一"写一坨 fallback
- **不写死代码**：没有实际调用路径的代码片段一律不写
- **类型从源头推导**：能用 `zod` schema 推导的类型就不要手写 interface
- 异步优先（`async/await`），尤其涉及批量 LLM 调用时
- 日志用 `console.log` / `console.error` 即可，不要引入重量级日志框架
- **版本从新**：所有依赖、库、参考文档一律查找最新稳定版，禁止使用已过期或 EOL 的版本

## 关键约束
- Token 通过 `.env` 中 `CANVAS_TOKEN` 注入，**绝不硬编码**
- `.env` 不入库，`.env.example` 提供模板
- 分页是所有 list API 的必须行为，默认只返回 10 条
- `include[]=submission_comments` 在拉取 submission 时带上，减少额外请求
- LLM 评分结果必须可追溯：每次评分记录 prompt、response、parsed score
