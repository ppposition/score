# Canvas LMS 作业提交 API 使用指南

> 适用于助教（TA）/教师获取学生在 Canvas 上提交的作业。
> 以下基于 [SJTU-Canvas-Helper](https://github.com/your-repo) 项目的实际调用方式整理。

---

## 1. 前置准备

### 1.1 获取 Access Token

在 Canvas 的 **账号 → 设置（Settings）** 页面底部生成一个 Access Token，所有 API 请求都需要通过此 Token 鉴权。

### 1.2 Base URL

```
https://<你的学校>.instructure.com
```

例如上海交大默认账户：`https://oc.sjtu.edu.cn`

---

## 2. 鉴权方式

所有请求在 Header 中携带 Bearer Token：

```
Authorization: Bearer <your_access_token>
```

示例（curl）：

```bash
curl -H "Authorization: Bearer <token>" \
  "https://oc.sjtu.edu.cn/api/v1/courses/12345/assignments"
```

---

## 3. 核心 API 端点

### 3.1 获取课程列表

```
GET /api/v1/courses?include[]=teachers&include[]=term
```

**查询参数**：

| 参数 | 值 | 说明 |
|------|-----|------|
| `include[]` | `teachers` | 同时返回教师信息 |
| `include[]` | `term` | 同时返回学期信息 |
| `per_page` | `100`（推荐） | 每页条数 |
| `page` | `1, 2, 3...` | 页码 |

**返回** `Course[]`，每个 `Course` 包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int | 课程 ID |
| `uuid` | string | 课程 UUID |
| `name` | string | 课程名称 |
| `course_code` | string | 课程代码 |
| `enrollments` | Enrollment[] | 当前用户的注册信息（含角色） |
| `access_restricted_by_date` | bool? | 是否因日期限制不可访问 |
| `teachers` | Teacher[] | 教师列表（需 `include[]=teachers`） |
| `term` | Term | 学期信息（需 `include[]=term`） |

**Enrollment 结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 注册类型 |
| `role` | string | 角色：`"StudentEnrollment"` / `"TaEnrollment"` / `"TeacherEnrollment"` / `"DesignerEnrollment"` / `"ObserverEnrollment"` |
| `role_id` | int | 角色 ID |
| `user_id` | int | 用户 ID |
| `enrollment_state` | string | 注册状态（`"active"` 等） |

**Teacher 结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int | 教师 ID |
| `display_name` | string | 教师显示名称 |
| `avatar_image_url` | string | 头像 URL |

**Term 结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int | 学期 ID |
| `name` | string | 学期名称（如 `"2024-2025学年第二学期"`） |
| `start_at` | string? | 学期开始时间 |
| `end_at` | string? | 学期结束时间 |

**如何判断是否是该课程的 TA/教师**：

遍历 `enrollments`，如果存在 `role` 为 `"TaEnrollment"` 或 `"TeacherEnrollment"`，则当前用户对该课程有管理权限。

**示例**：

```bash
curl -H "Authorization: Bearer <token>" \
  "https://oc.sjtu.edu.cn/api/v1/courses?include[]=teachers&include[]=term&per_page=100&page=1"
```

**响应示例**（简化）：

```json
[
  {
    "id": 12345,
    "uuid": "abc123...",
    "name": "数据结构",
    "course_code": "CS2001",
    "enrollments": [
      {
        "type": "TaEnrollment",
        "role": "TaEnrollment",
        "role_id": 456,
        "user_id": 789,
        "enrollment_state": "active"
      }
    ],
    "teachers": [
      {
        "id": 100,
        "display_name": "张三",
        "avatar_image_url": "https://..."
      }
    ],
    "term": {
      "id": 10,
      "name": "2024-2025学年第二学期",
      "start_at": "2025-02-17T00:00:00Z",
      "end_at": "2025-06-30T00:00:00Z"
    }
  }
]
```

> **注意**：如果某个课程的 `access_restricted_by_date` 为 `true`，说明该课程尚未对学生开放，可以过滤掉。

---

### 3.2 获取课程的所有作业

```
GET /api/v1/courses/{course_id}/assignments
```

**返回** `Assignment[]`，每个 `Assignment` 包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int | 作业 ID |
| `name` | string | 作业名称 |
| `description` | string? | 作业描述（HTML） |
| `due_at` | string? | 截止时间（ISO 8601） |
| `unlock_at` | string? | 解锁时间 |
| `lock_at` | string? | 锁定时间 |
| `points_possible` | number? | 满分 |
| `needs_grading_count` | number? | 待批改数量（仅 TA/教师可见） |
| `submission_types` | string[] | 提交类型（如 `["online_upload"]`） |
| `has_submitted_submissions` | bool | 是否有人已提交 |
| `grading_type` | string | 评分类型（`pass_fail` / `points` 等） |

**示例**：

```bash
curl -H "Authorization: Bearer <token>" \
  "https://oc.sjtu.edu.cn/api/v1/courses/12345/assignments"
```

---

### 3.3 获取单个作业的完整描述

列表接口 (`3.2`) 返回的 `description` 字段可能是截断版本（Canvas 会对列表中的描述进行截断以减小响应体积）。如需获取**完整的**作业描述（含所有 HTML 内容、图片、链接等），应请求单个作业端点：

```
GET /api/v1/courses/{course_id}/assignments/{assignment_id}
```

**查询参数**：

| 参数 | 值 | 说明 |
|------|-----|------|
| `include[]` | `overrides` | 同时返回 DDL 覆盖 |
| `include[]` | `all_dates` | 同时返回所有日期 |
| `include[]` | `score_statistics` | 同时返回分数统计 |

**返回** 单个 `Assignment` 对象，字段同 `3.2`，但 `description` 为完整 HTML。

> **提示**：本项目在 `list_course_assignments` 中已使用 `include[]` 参数一次性拉取 submission、overrides、all_dates 和 score_statistics，`description` 字段也随列表返回。如果你的场景中描述被截断，可单独调用此端点获取完整内容。

**示例**：

```bash
curl -H "Authorization: Bearer <token>" \
  "https://oc.sjtu.edu.cn/api/v1/courses/12345/assignments/67890"
```

**响应示例**（简化，重点关注 description）：

```json
{
  "id": 67890,
  "name": "第一次实验报告",
  "description": "<h2>实验要求</h2><p>请完成以下任务：</p><ol><li>实现二叉树的遍历算法</li><li>分析时间复杂度</li><li>撰写实验报告</li></ol><p>提交格式：<strong>PDF</strong></p><img src=\"...\" alt=\"示例图\" />",
  "due_at": "2025-04-15T23:59:59Z",
  "points_possible": 100,
  "submission_types": ["online_upload"],
  "allowed_extensions": ["pdf", "docx"],
  "grading_type": "points"
}
```

---

### 3.4 获取某作业的所有学生提交（批量）

```
GET /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions
```

**查询参数**：

| 参数 | 值 | 说明 |
|------|-----|------|
| `include[]` | `submission_comments` | 同时返回评语 |
| `per_page` | `100`（推荐） | 每页条数，最大 100 |
| `page` | `1, 2, 3...` | 页码 |

**返回** `Submission[]`，每个 `Submission` 包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int | 提交 ID |
| `user_id` | int | 学生 ID |
| `grade` | string? | 分数 |
| `submitted_at` | string? | 提交时间 |
| `late` | bool | 是否迟交 |
| `workflow_state` | string | `"submitted"` / `"unsubmitted"` / `"graded"` / `"pending_review"` |
| `attachments` | Attachment[] | 学生上传的附件列表 |
| `submission_comments` | Comment[] | 评语列表 |

**Attachment 结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int | 附件 ID |
| `display_name` | string | 显示名称 |
| `filename` | string | 文件名 |
| `url` | string | 下载 URL |
| `content-type` | string | MIME 类型 |
| `size` | number | 文件大小（字节） |

**示例**：

```bash
curl -H "Authorization: Bearer <token>" \
  "https://oc.sjtu.edu.cn/api/v1/courses/12345/assignments/67890/submissions?include[]=submission_comments&per_page=100&page=1"
```

---

### 3.5 获取单个学生的提交

```
GET /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{student_id}
```

**查询参数**：

| 参数 | 值 | 说明 |
|------|-----|------|
| `include[]` | `submission_comments` | 同时返回评语 |

**示例**：

```bash
curl -H "Authorization: Bearer <token>" \
  "https://oc.sjtu.edu.cn/api/v1/courses/12345/assignments/67890/submissions/11111?include[]=submission_comments"
```

---

### 3.6 获取课程学生列表

```
GET /api/v1/courses/{course_id}/users?enrollment_type[]=student
```

**示例**：

```bash
curl -H "Authorization: Bearer <token>" \
  "https://oc.sjtu.edu.cn/api/v1/courses/12345/users?enrollment_type[]=student&per_page=100"
```

---

### 3.7 给学生打分

```
POST /api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/update_grades
```

**表单参数**（`application/x-www-form-urlencoded`）：

| 参数 | 说明 |
|------|------|
| `grade_data[{student_id}][posted_grade]` | 分数 |
| `grade_data[{student_id}][text_comment]` | 评语（可选） |

**示例**：

```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -d "grade_data[11111][posted_grade]=95" \
  -d "grade_data[11111][text_comment]=做得很好" \
  "https://oc.sjtu.edu.cn/api/v1/courses/12345/assignments/67890/submissions/update_grades"
```

---

### 3.8 修改作业截止时间（仅 TA/教师）

```
PUT /api/v1/courses/{course_id}/assignments/{assignment_id}
```

**表单参数**：

| 参数 | 说明 |
|------|------|
| `assignment[due_at]` | 新的截止时间 |
| `assignment[lock_at]` | 新的锁定时间 |

---

## 4. 分页处理

Canvas API 使用基于页码的分页方式。每页最多 100 条。**典型的分页逻辑**（伪代码）：

```
page = 1
all_items = []
loop:
    items = GET /api/v1/...?per_page=100&page={page}
    if items is empty: break
    all_items.extend(items)
    page += 1
return all_items
```

**Python 实现示例**：

```python
import requests

def list_all(url, token):
    all_items = []
    page = 1
    while True:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            params={"per_page": 100, "page": page}
        )
        resp.raise_for_status()
        items = resp.json()
        if not items:
            break
        all_items.extend(items)
        page += 1
    return all_items
```

**Rust 实现**（参考本项目 `src-tauri/src/client/basic.rs`）：

```rust
pub async fn list_items<T: DeserializeOwned>(&self, url: &str, token: &str) -> Result<Vec<T>> {
    let mut all_items = vec![];
    let mut page = 1;
    loop {
        let items = self.list_items_with_page(url, token, page).await?;
        if items.is_empty() { break; }
        page += 1;
        all_items.extend(items);
    }
    Ok(all_items)
}
```

**TypeScript 实现**：

```typescript
async function listAll<T>(url: string, token: string): Promise<T[]> {
  const allItems: T[] = [];
  let page = 1;
  while (true) {
    const resp = await fetch(`${url}?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const items: T[] = await resp.json();
    if (items.length === 0) break;
    allItems.push(...items);
    page++;
  }
  return allItems;
}
```

---

## 5. 完整示例：助教批量下载所有课程的学生提交文件

```python
import requests
import os
import time

BASE_URL = "https://oc.sjtu.edu.cn"
TOKEN = "your_access_token"
DOWNLOAD_DIR = "./submissions"


def list_all(url, extra_params=None):
    """分页获取所有数据"""
    all_items = []
    page = 1
    params = {"per_page": 100, "page": page}
    if extra_params:
        params.update(extra_params)
    while True:
        params["page"] = page
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {TOKEN}"},
            params=params,
        )
        resp.raise_for_status()
        items = resp.json()
        if not items:
            break
        all_items.extend(items)
        page += 1
        time.sleep(0.1)  # 避免触发频率限制
    return all_items


def get_ta_courses():
    """获取当前用户作为 TA 或教师的课程列表"""
    url = f"{BASE_URL}/api/v1/courses"
    courses = list_all(url, extra_params={
        "include[]": ["teachers", "term"],
    })
    # 过滤：仅保留有 TA/Teacher 权限的课程
    ta_courses = []
    for course in courses:
        for enrollment in course.get("enrollments", []):
            if enrollment["role"] in ("TaEnrollment", "TeacherEnrollment"):
                ta_courses.append(course)
                break
    # 过滤掉因日期受限无法访问的课程
    ta_courses = [
        c for c in ta_courses
        if not c.get("access_restricted_by_date", False)
    ]
    return ta_courses


def get_students(course_id):
    """获取课程学生列表"""
    url = f"{BASE_URL}/api/v1/courses/{course_id}/users"
    return list_all(url, extra_params={"enrollment_type[]": "student"})


def get_assignments(course_id):
    """获取课程所有作业"""
    url = f"{BASE_URL}/api/v1/courses/{course_id}/assignments"
    return list_all(url)


def get_submissions(course_id, assignment_id):
    """获取某作业所有提交"""
    url = f"{BASE_URL}/api/v1/courses/{course_id}/assignments/{assignment_id}/submissions"
    return list_all(url, extra_params={"include[]": "submission_comments"})


def download_file(url, save_path):
    """下载单个文件"""
    resp = requests.get(url, headers={"Authorization": f"Bearer {TOKEN}"}, stream=True)
    resp.raise_for_status()
    with open(save_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
    print(f"  已下载: {save_path}")


def main():
    # 1. 获取助教的所有课程
    print("获取课程列表...")
    courses = get_ta_courses()
    print(f"找到 {len(courses)} 门课程\n")

    for course in courses:
        course_id = course["id"]
        course_name = course["name"]
        print(f"=== 课程: {course_name} (ID: {course_id}) ===")

        # 2. 获取学生名单
        print("  获取学生名单...")
        students = get_students(course_id)
        student_map = {s["id"]: s["name"] for s in students}
        print(f"  共 {len(students)} 名学生")

        # 3. 获取所有作业
        print("  获取作业列表...")
        assignments = get_assignments(course_id)

        for assignment in assignments:
            assignment_id = assignment["id"]
            assignment_name = assignment["name"]
            print(f"\n  --- 作业: {assignment_name} ---")

            # 4. 获取所有提交
            submissions = get_submissions(course_id, assignment_id)
            print(f"  共 {len(submissions)} 份提交")

            # 5. 创建作业下载目录
            course_dir = os.path.join(DOWNLOAD_DIR, course_name)
            assignment_dir = os.path.join(course_dir, assignment_name)
            os.makedirs(assignment_dir, exist_ok=True)

            # 6. 遍历提交，下载文件
            for sub in submissions:
                user_id = sub["user_id"]
                student_name = student_map.get(user_id, f"学生{user_id}")
                grade = sub.get("grade") or "未评分"
                late = "迟交" if sub.get("late") else "按时"

                print(f"  {student_name} | 分数: {grade} | {late}")

                for att in sub.get("attachments", []):
                    filename = f"{student_name}_{att['filename']}"
                    save_path = os.path.join(assignment_dir, filename)
                    download_file(att["url"], save_path)


if __name__ == "__main__":
    main()
```

### 运行效果

```
获取课程列表...
找到 2 门课程

=== 课程: 数据结构 (ID: 12345) ===
  获取学生名单...
  共 60 名学生
  获取作业列表...

  --- 作业: 第一次实验报告 ---
  共 58 份提交
  张三 | 分数: 95 | 按时
    已下载: ./submissions/数据结构/第一次实验报告/张三_实验报告1.pdf
  李四 | 分数: 未评分 | 迟交
    已下载: ./submissions/数据结构/第一次实验报告/李四_实验报告1.docx
  ...
```

---

## 6. 注意事项

1. **频率限制**：Canvas API 有速率限制（通常约 700 次/分钟），大量请求时应适当加入延迟。
2. **分页必做**：不指定 `per_page` 默认只返回 10 条，一定要用分页逻辑遍历所有数据。
3. **Token 安全**：不要在客户端代码中硬编码 Token，应通过环境变量或配置文件管理。
4. **`include[]` 参数**：请求 submissions 时带上 `include[]=submission_comments` 可以一次性获取评语，避免额外请求。
5. **`workflow_state`**：注意区分 `"unsubmitted"`（未提交）、`"submitted"`（已提交未评分）、`"graded"`（已评分）。
6. **权限**：学生只能看到自己的提交；TA 和教师可以看到所有学生的提交和 `needs_grading_count`。

---

## 7. 相关资源

- [Canvas LMS API 官方文档 - Submissions](https://canvas.instructure.com/doc/api/submissions.html)
- [Canvas LMS API 官方文档 - Assignments](https://canvas.instructure.com/doc/api/assignments.html)
- [Canvas LMS API 官方文档 - Courses](https://canvas.instructure.com/doc/api/courses.html)
