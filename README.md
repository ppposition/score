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
│   └── grader.ts       # 调用 LLM（Responses API），解析 JSON 结果
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
- **`grader.ts`**：`gradeSubmission()` 函数，先通过 `loadAssignment()` 从指定题目文件提取计分清单，再接收学生附件与清单进行评分。返回 `{ score, maxScore, comment, items }`，由程序根据逐项完成情况累加总分。

### `src/cli/` — 命令行入口

提供三个子命令：

| 命令 | 功能 |
|------|------|
| `grade` | 批量评分：读取题目文件 → 拉取提交及附件 → 按完成情况评分 → 写回 Canvas |
| `download` | 下载某作业所有学生的附件到本地 |
| `list` | 列出课程所有作业（id + 名称 + 满分） |

`grade` 支持 `--dry-run` 模式，仅评分不回写。默认满分只写回分数，有扣分才写回评语。本地记录仍保留所有评语；设置 `.env` 中 `SKIP_FULL_SCORE_COMMENT=false` 或使用 `--include-full-score-comment` 可恢复满分也提交评语。Agent 的 `grade-all` 和 `post-grades` 可用 `skipFullScoreComment` 参数覆盖此设置。旧记录缺少 `maxScore` 时仍提交评语。

## PDF 和 Markdown 附件

Agent 的单人/批量评分与 CLI `grade` 共用附件处理：

- 扫描 PDF 用 Poppler 逐页转成 JPEG（长边 2400 像素），保留页序，再交给视觉模型读取手写内容、公式和图表。
- `.md` / `.markdown` 按 UTF-8 读取原文，保留标题、代码块和公式；也支持 TXT、IPYNB 等文本文件。
- 可在同一提交中混合 PDF 和 MD。没有附件、下载失败、非法 UTF-8、不支持的格式、PDF 损坏或转换失败均停止评分，不生成或写回该次评分。
- 每次 Canvas 提交原始附件总大小最多 50 MiB、PDF 总页数最多 30 页，每个 PDF 转出的图片合计最多 50 MiB。超限会报错，不会截断。

运行扫描 PDF 前安装 Poppler（当前开发环境已安装）：

```bash
sudo apt-get install poppler-utils
```

在 `.env` 设置 `LLM_VISION_MODEL`，模型及服务必须支持 Responses API 的 `input_image`（Base64 图片）。未配置时会提示错误；文本评分仍使用 `LLM_MODEL`。视觉服务可通过 `LLM_VISION_BASE_URL` 和 `LLM_VISION_API_KEY` 独立配置，留空复用现有服务。图片输入格式参见 [Responses 图片输入文档](https://developers.openai.com/api/docs/guides/images-vision)。

交互式 agent 也支持本地附件：

```text
/attach ./submissions/作业.pdf
/attach "./评分标准.md"
请按照评分标准批改这份作业
```

`/attach` 可重复添加；附件随下一条自然语言消息发送。PDF 对话及后续多轮对话使用视觉模型，因此该模型还需支持工具调用；`/clear` 清除历史和待发送附件。Markdown 中的图片链接仅作为文字，不会自动下载。

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
npm run grade -- -c <课程ID> -a <作业ID> -f ./作业1.md
# 先试运行（不回写）：
npm run grade -- -c <课程ID> -a <作业ID> -f ./作业1.md --dry-run
```

## 环境变量

参见 `.env.example`：

| 变量 | 说明 |
|------|------|
| `CANVAS_BASE_URL` | Canvas 实例 URL |
| `CANVAS_TOKEN` | Canvas Access Token |
| `LLM_BASE_URL` | Responses API 基址，例如 `https://open.bigmodel.cn/api/v1`，代码自动追加 `/responses` |
| `LLM_API_KEY` | LLM API Key |
| `LLM_MODEL` | 模型名，默认 `glm-5.3-flash` |

## 评分规则与流程

带有标准 `第X章`、`第X题` 标题的 Markdown 文件由程序按标题和显式小题编号直接提取，保留公共题干与公式，不依赖模型生成题号；其他格式使用模型提取。程序忽略 Markdown 的目录、题号汇总表，以及代码块和公式中的编号。

CLI 必须通过 `-f, --assignment-file <path>` 指定本地题目文件；Agent 的 `grade-submission` 和 `grade-all` 工具必须提供 `assignmentFile`。支持 MD、TXT、PDF 等已有附件格式，PDF 题目文件同样需要视觉模型。

```text
读取指定题目文件 → 提取题目/小题清单（批量仅提取一次）
                → 获取对应学生提交 → 加载学生全部附件
                → 逐项检查完成情况 → 程序累加分数 → 保存记录/写回 Canvas
```

- 有明确编号的小题时，每个小题满分 10 分，父题不重复计分；没有小题时整题满分 10 分。同一题中的多个公式或要求不会自行拆分为小题。
- 覆盖该项全部要求且有实质解答、不明显敷衍，得 10 分；不判断答案对错，也不因迟交、格式等扣分。
- 缺失、未完成或明显敷衍的计分项得 0 分，明细记录具体原因。合理的简短解答也可得满分。
- 总满分为计分项数量 × 10，不固定为 100 分，不转换成百分制。写回 Canvas 的是该原始分数。
- 文件不存在、题目为空、题目清单或评分明细不完整、关键内容无法辨认时停止评分。

评分记录包含总分 `score`、满分 `maxScore`、评语 `comment` 和逐项明细 `items`（题目 ID、完成状态、理由、得分、满分）。

Agent 示例：

```text
给课程 12345 作业 67890 评分，题目文件是 ./作业1.md，先不写回 Canvas
```
