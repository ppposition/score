# Canvas Auto-Grader

基于 Canvas LMS API + 大模型的自动打分 Agent。

## 项目结构

```
src/
├── api/                # Canvas API 封装层
│   ├── types.ts        # zod schema — 定义 API 返回结构，同时推导 TS 类型
│   └── canvas.ts       # HTTP 客户端 — 分页拉取、鉴权、提交/作业/用户端点、写回分数
├── grader/             # LLM 评分核心
│   ├── prompts.ts      # 评分 prompt 模板（系统提示词 + 用户提示词）
│   └── grader.ts       # 调用 LLM（OpenAI 兼容接口），解析 JSON 结果
└── cli/
    └── index.ts        # 命令行入口（commander）：list / download / grade 三个子命令
```

### `src/api/` — Canvas API 封装

- **`types.ts`**：用 `zod` 定义所有 Canvas API 响应结构（`Submission`, `Assignment`, `User` 等）。运行时校验 + 自动推导 TS 类型，不手写 interface。
- **`canvas.ts`**：封装所有 Canvas REST 调用：
  - `listAll<T>()`：通用分页函数，自动翻页直到无数据返回
  - `getAssignments()` / `getSubmissions()` / `getStudents()`：获取作业、提交、学生列表
  - `postGrades()`：批量写回分数和评语
  - `downloadAttachment()`：下载学生附件

### `src/grader/` — LLM 评分核心

- **`prompts.ts`**：评分 prompt 模板。`SYSTEM_PROMPT` 定义评分的角色和规则，`SCORING_PROMPT` 是带占位符的用户提示词模板（`{assignmentDescription}`, `{submissionContent}`）。
- **`grader.ts`**：`gradeSubmission()` 函数，接收学生提交内容和作业描述，调用 LLM 返回 `{ score, comment }`，同时记录完整的 prompt 和 rawResponse 用于追溯。

### `src/cli/` — 命令行入口

提供三个子命令：

| 命令 | 功能 |
|------|------|
| `grade` | 批量评分：拉取提交 → 调用 LLM → 写回 Canvas |
| `download` | 下载某作业所有学生的附件到本地 |
| `list` | 列出课程所有作业（id + 名称 + 满分） |

`grade` 支持 `--dry-run` 模式，仅评分不回写。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 CANVAS_TOKEN、LLM_API_KEY 等

# 3. 列出作业
npm run list -- -c <课程ID>

# 4. 下载提交
npm run download -- -c <课程ID> -a <作业ID>

# 5. 自动评分
npm run grade -- -c <课程ID> -a <作业ID>
# 先试运行（不回写）：
npm run grade -- -c <课程ID> -a <作业ID> --dry-run
```

## 环境变量

参见 `.env.example`：

| 变量 | 说明 |
|------|------|
| `CANVAS_BASE_URL` | Canvas 实例 URL |
| `CANVAS_TOKEN` | Canvas Access Token |
| `LLM_BASE_URL` | LLM API 地址（兼容 OpenAI 接口） |
| `LLM_API_KEY` | LLM API Key |
| `LLM_MODEL` | 模型名，默认 `gpt-4o` |

## 评分流程

```
拉取作业描述 ──→ 拉取所有提交 ──→ 逐个下载附件内容
                                      │
                                      ▼
                              拼接 prompt 模板
                                      │
                                      ▼
                               调用 LLM 评分
                                      │
                                      ▼
                          { score, comment }  ← 记录 JSON
                                      │
                                      ▼
                           POST /update_grades 写回 Canvas
```
