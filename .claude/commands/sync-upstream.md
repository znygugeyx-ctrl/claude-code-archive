# Sync Upstream: 检测官方 Claude Code CHANGELOG 变更并更新 SYNC.md

你是一个代码同步助手。通过 GitHub API 获取官方 CHANGELOG.md 的增量变更，分析后更新项目根目录的 `SYNC.md`。

## 参数

- 无参数: 检测新版本并更新 SYNC.md
- `--npm`: 同时逆向最新 npm 包对比实现细节
- `--check`: 仅检查是否有新版本，不修改文件

## 执行流程

### Step 1: 读取当前同步状态

读取项目根目录的 `SYNC.md`，从头部元数据提取：
- `上次检查` 日期
- `官方最新` 版本号
- `本地基线` 版本号

如果 `SYNC.md` 不存在，告知用户运行首次初始化。

### Step 2: 获取 CHANGELOG 增量变更

通过 GitHub API 获取 CHANGELOG.md 在上次检查日期之后的 commit：

```bash
gh api "repos/anthropics/claude-code/commits?path=CHANGELOG.md&since=<上次检查日期>T00:00:00Z&per_page=20" \
  --jq '.[] | {sha: .sha[:8], date: .commit.committer.date}'
```

如果没有新 commit，告知用户"已是最新"并结束。

### Step 3: 解析每个 commit 的 diff

对每个新 commit 获取 CHANGELOG.md 的 diff：

```bash
gh api "repos/anthropics/claude-code/commits/<sha>" \
  --jq '.files[] | select(.filename=="CHANGELOG.md") | .patch'
```

从 diff 中提取：
- 新版本号：匹配 `+## <version>` 格式的行
- 变更条目：匹配 `+- <description>` 格式的行
- 变更类型：从描述开头提取（Added/Fixed/Improved/Changed/Other）

### Step 4: 检查 SYNC.md 中已有的版本

读取 SYNC.md，检查提取到的每个版本号是否已存在（`## <version>` 标题）。
**跳过已存在的版本**（幂等性保证）。

### Step 5: 对新条目分类优先级

按以下规则自动分类：

**🔴 高优先级** — 描述中包含以下关键词（不区分大小写）：
`hook`, `permission`, `tool`, `agent`, `SDK`, `MCP`, `API`, `model`, `worktree`, `headless`, `-p`, `--print`, `subagent`

**🟢 低优先级** — 描述中包含以下关键词：
`UI`, `style`, `copy`, `rendering`, `scroll`, `flicker`, `jitter`, `badge`, `notification`, `deep link`, `paste`

**➖ 不适用** — 描述中包含以下关键词：
`Windows`, `PowerShell`, `voice`, `mobile`, `VSCode`, `Apple Silicon`, `April`

**🟡 中优先级** — 以上均未匹配的默认优先级

### Step 6: 生成新版本的表格

对每个新版本，按优先级分组生成 Markdown 表格：

```markdown
## <version>

### 🔴 高优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | 功能描述 | ❌ | |

### 🟡 中优先级
...

### 🟢 低优先级
...

### ➖ 不适用
...
```

**新条目的默认状态为 ❌**。不自动搜索 src/（首次初始化时已搜索，后续由用户手动更新状态）。

### Step 7: 更新 SYNC.md

1. 更新头部元数据：
   - `上次检查` → 当前日期
   - `官方最新` → 最新检查到的版本号
2. 在 `---` 分隔线之后、第一个已有版本之前，插入新版本表格（新版本在前）
3. **不修改已有版本的表格**（保护用户手动更新的状态和备注）

### Step 8: 输出摘要报告

```
📋 Sync Report
检查时间: YYYY-MM-DD
新增版本: N 个 (列出版本号)
新增条目: X 条 (🔴 N / 🟡 N / 🟢 N / ➖ N)
SYNC.md 已更新
```

### Step 9: 逆向 npm 包（可选，仅 --npm 参数）

如果用户附加了 `--npm` 参数：

1. 获取最新 npm 包版本：
   ```bash
   npm view @anthropic-ai/claude-code version
   ```

2. 下载并解包：
   ```bash
   mkdir -p /tmp/claude-code-npm
   npm pack @anthropic-ai/claude-code --pack-destination /tmp/claude-code-npm/
   cd /tmp/claude-code-npm && tar -xzf *.tgz
   ```

3. 格式化 bundle（通常是 minified）：
   ```bash
   npx prettier --write /tmp/claude-code-npm/package/dist/**/*.js
   ```

4. 对比 SYNC.md 中 ❌ 状态的高优先级条目：
   - 在解包代码中搜索相关关键词
   - 对比本地 src/ 与 bundle 的实现差异
   - 将发现的实现细节补充到 SYNC.md 对应条目的备注列

5. 清理：
   ```bash
   rm -rf /tmp/claude-code-npm
   ```

## 注意事项

- CHANGELOG 描述是功能层面的，不是代码层面的
- 官方 CHANGELOG 更新频繁（每 1-2 天），建议每周运行一次
- 不要自动修改代码，只更新 SYNC.md 的状态追踪
- 已有条目的状态和备注由用户手动维护，skill 不覆盖
