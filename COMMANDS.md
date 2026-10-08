# 命令清单

## 前置知识

这个项目用 TypeScript 编写，通过 `tsx` 直接运行 `.ts` 文件，不需要先编译成 `.js`。

---

## 1. 初始化

```bash
# 安装项目依赖（只需要执行一次）
npm install
```

这条命令读取 `package.json` 里的 `dependencies` 和 `devDependencies`，把所有依赖下载到 `node_modules/`。

---

## 2. 配置环境变量

```bash
cp .env.example .env
# 然后用编辑器打开 .env，填入你的 Token 和 API Key
```

`.env` 文件内容说明：

| 变量 | 含义 | 示例 |
|------|------|------|
| `CANVAS_BASE_URL` | Canvas 实例地址 | `https://oc.sjtu.edu.cn` |
| `CANVAS_TOKEN` | Canvas 个人 Access Token | 在 Canvas → 账号 → 设置 里生成 |
| `LLM_BASE_URL` | LLM API 地址 | OpenAI: `https://api.openai.com/v1`，DeepSeek: `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | LLM API Key | 从 LLM 平台获取 |
| `LLM_MODEL` | 模型名 | `gpt-4o` / `deepseek-chat` 等 |

> `.env` 文件不会被 git 提交（写入 `.gitignore`），不要把你的 Token 发到 GitHub。

---

## 3. 启动 Agent（推荐）

```bash
npm run agent
```

进入自然语言对话模式，Agent 自动调用工具来响应你。

### 对话示例

```
agent > 列出我的课程
agent > 查看课程 12345 的作业
agent > 给课程 12345 作业 67890 打分，题目文件是 ./作业1.md，先不写回 Canvas
agent > 把刚才的评分结果写回 Canvas
```

### 内置命令

| 命令 | 说明 |
|------|------|
| `/course <id>` | 设置当前课程（后续对话自动带入） |
| `/assignment <id>` | 设置当前作业 |
| `/status` | 查看当前上下文 |
| `/clear` | 清空对话历史 |
| `exit` / `quit` | 退出 Agent |

---

## 4. 传统命令行模式

```bash
# 查看所有可用命令
npm run list -- --help
# 或
npx tsx src/cli/index.ts --help
```

```bash
# 列出课程/作业
npm run list
npm run list -- -c 12345

# 下载附件
npm run download -- -c 12345 -a 67890

# 批量评分
npm run grade -- -c 12345 -a 67890 -f ./作业1.md
npm run grade -- -c 12345 -a 67890 -f ./作业1.md --dry-run
```

> `--` 的作用：`npm run` 后的参数需要用 `--` 分隔，才能传给脚本，否则会被 npm 自己吃掉。

---

## 4. `list` — 列出信息

### 列出你作为 TA/教师的课程

```bash
npm run list
```

输出示例：
```
[77261] 人工智能导论 (2024-2025学年第二学期)
[83037] 计算方法
```

### 列出某个课程的所有作业

```bash
npm run list -- -c <课程ID>
```

示例：
```bash
npm run list -- -c 77261
```

输出示例：
```
[332837] 绪论  (满分: 5)
[338253] 语言模型在数学中的应用  (满分: 30)
[348038] 期末小论文  (满分: 30)
```

只有你有 TA/Teacher 权限的课程才会出现在课程列表中。

---

## 5. `download` — 下载学生提交

把某作业所有学生的附件下载到本地文件夹。

```bash
npm run download -- -c <课程ID> -a <作业ID>
```

可选参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-c, --course <id>` | 课程 ID（必填） | — |
| `-a, --assignment <id>` | 作业 ID（必填） | — |
| `-o, --out <dir>` | 输出目录 | `./submissions` |

示例：
```bash
npm run download -- -c 77261 -a 338253 -o ./downloads/ai_homework
```

下载后的文件命名格式：`{学生姓名}_{原始文件名}`。比如 `张三_实验报告1.pdf`。

---

## 6. `grade` — 自动评分

先读取指定的本地题目文件并提取计分清单，再拉取对应学生附件，逐项按完成情况评分，最后写回 Canvas。每个小题10分，无小题整题10分；完整且不明显敷衍就得满分，不判断答案对错。缺失、未完成或明显敷衍的项得0分。总满分按计分项数量计算，不固定为100分。

```bash
# 正式评分（会写回 Canvas）
npm run grade -- -c <课程ID> -a <作业ID> -f ./作业1.md

# 试运行（只评分不回写，检查效果）
npm run grade -- -c <课程ID> -a <作业ID> -f ./作业1.md --dry-run
```

可选参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-c, --course <id>` | 课程 ID（必填） | — |
| `-a, --assignment <id>` | 作业 ID（必填） | — |
| `-f, --assignment-file <path>` | 本地题目文件（必填，支持 MD、TXT、PDF 等） | — |
| `--dry-run` | 只评分不回写 | `false` |
| `--include-full-score-comment` | 满分也提交评语，覆盖环境设置 | 未启用 |

运行后会在当前目录的 `output/` 文件夹生成一个 `grading_records_{作业ID}_{时间戳}.json` 文件，目录自动创建并已加入 `.gitignore`。迟交在题目得分汇总后扣分：1天以内扣10分，超过1天至2天扣20分，超过2天至7天扣30分，超过7天至28天扣40分，超过28天扣50分（各档上限包含当天，1天为24小时，最终最低0分）。文件记录扣分前题目得分、迟交秒数、迟交扣分、最终总分、满分、评语及每项完成状态、理由和得分，用于追溯。写回 Canvas 的是原始总分，不转换成百分制。默认满分只提交分数，有扣分才提交评语；本地记录始终保留评语。可在 `.env` 设置 `SKIP_FULL_SCORE_COMMENT=false`，或加 `--include-full-score-comment`，使满分也提交评语。

### 评分流程

在 `.env` 设置 `SKIP_GRADED_SUBMISSIONS=true` 可跳过 Canvas 状态为 `graded` 的提交（包括 0 分）；设为 `false` 或不设置时允许重新评分。重新提交后状态为 `submitted` 的作业仍会评分。此设置适用于 CLI、Agent 单人/批量评分及评分记录写回，`--dry-run` 也遵循此设置。新评分记录包含 `userId`，跳过部分学生后仍能准确写回对应学生。

1. 读取指定题目文件并提取题目/小题清单，批量只提取一次
2. 拉取该作业所有已提交的 submission
3. 加载每个学生的全部附件（PDF 按页序渲染图片）
4. 用统一计分清单逐项检查完成情况
5. 程序按每个完成项10分累加，返回 `{ score, maxScore, comment, items }`
6. 汇总后调用 Canvas API 批量写回分数和评语

---

## 7. 直接用 `tsx` 运行（不用 npm scripts）

如果你不想通过 `npm run`，也可以直接运行：

```bash
npx tsx src/cli/index.ts list
npx tsx src/cli/index.ts list -c 77261
npx tsx src/cli/index.ts download -c 77261 -a 338253
npx tsx src/cli/index.ts grade -c 77261 -a 338253 -f ./作业1.md --dry-run
```

`npx tsx` 会临时调用 `tsx` 来执行 TypeScript 文件，不需要手动安装 tsx 到全局。

---

## 8. 类型检查（不运行，只检查类型错误）

```bash
npx tsc --noEmit
```

`tsc` 是 TypeScript 编译器，`--noEmit` 表示只检查类型不生成 `.js` 文件。用于验证类型有没有写错，适合提交代码前跑一下。

---

## Cheat Sheet（速查）

| 你想做什么 | 命令 |
|-----------|------|
| 看我有哪些课 | `npm run list` |
| 看某课的作业 | `npm run list -- -c <ID>` |
| 下载学生作业文件 | `npm run download -- -c <ID> -a <ID>` |
| 试评分（不回写） | `npm run grade -- -c <ID> -a <ID> -f ./作业1.md --dry-run` |
| 正式评分（回写） | `npm run grade -- -c <ID> -a <ID> -f ./作业1.md` |
| 检查类型错误 | `npx tsc --noEmit` |
