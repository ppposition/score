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
agent > 给课程 12345 作业 67890 打分，先不写回 Canvas
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
npm run grade -- -c 12345 -a 67890
npm run grade -- -c 12345 -a 67890 --dry-run
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

拉取某作业的所有提交，逐个调用 LLM 打分，然后写回 Canvas。

```bash
# 正式评分（会写回 Canvas）
npm run grade -- -c <课程ID> -a <作业ID>

# 试运行（只评分不回写，检查效果）
npm run grade -- -c <课程ID> -a <作业ID> --dry-run
```

可选参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-c, --course <id>` | 课程 ID（必填） | — |
| `-a, --assignment <id>` | 作业 ID（必填） | — |
| `--dry-run` | 只评分不回写 | `false` |

运行后会在当前目录生成一个 `grading_records_{作业ID}_{时间戳}.json` 文件，记录每次评分的完整信息（prompt、LLM 原始回复、分数、评语），用于追溯。

### 评分流程

1. 获取作业描述（题目要求）
2. 拉取该作业所有已提交的 submission
3. 下载每个学生的附件内容，拼成文本
4. 把作业描述 + 学生内容填入 prompt 模板
5. 调用 LLM，解析返回的 JSON `{ score, comment }`
6. 汇总后调用 Canvas API 批量写回分数和评语

---

## 7. 直接用 `tsx` 运行（不用 npm scripts）

如果你不想通过 `npm run`，也可以直接运行：

```bash
npx tsx src/cli/index.ts list
npx tsx src/cli/index.ts list -c 77261
npx tsx src/cli/index.ts download -c 77261 -a 338253
npx tsx src/cli/index.ts grade -c 77261 -a 338253 --dry-run
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
| 试评分（不回写） | `npm run grade -- -c <ID> -a <ID> --dry-run` |
| 正式评分（回写） | `npm run grade -- -c <ID> -a <ID>` |
| 检查类型错误 | `npx tsc --noEmit` |
