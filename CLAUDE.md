# CLAUDE.md — Claude Code 会话上下文

## 项目简介

这是 [instructkr/claude-code](https://github.com/instructkr/claude-code) 的研究 fork。官方 [anthropics/claude-code](https://github.com/anthropics/claude-code) 没有公开源码，只有 CHANGELOG.md 记录版本变动。

- **origin**: `https://github.com/znygugeyx-ctrl/claude-code.git`（本 fork）
- **upstream**: `https://github.com/instructkr/claude-code.git`（逆向源码，参考用）
- **官方产品**: npm 上的 `@anthropic-ai/claude-code`

通过已有的 `/sync-upstream` skill 拉取官方 CHANGELOG 追踪版本变化，结合 `--npm` 参数逆向 npm 包获取实现细节。

## 分支策略

| 分支 | 用途 |
|------|------|
| `main` | 唯一工作分支，所有开发在此进行 |
| `archive` | 只读快照，受 git hooks 保护，不可修改 |

- 使用 `/sync-upstream` skill 追踪官方 CHANGELOG 变化
- `SYNC.md` 记录完整的功能同步状态（每条官方变更的实现状态和优先级）

## 构建和运行

前提：安装 [Bun](https://bun.sh/) 运行时

```bash
bun install          # 安装依赖
bun run build        # 构建 src/entrypoints/cli.tsx → dist/cli.js（via build.ts）
bun run start        # 运行（默认 CLAUDE_CODE_USE_BEDROCK=1）
bun run lint         # Biome 代码检查（宽松模式，适配反编译代码）
bun test             # 运行测试（Bun test runner）
bun run health       # 项目健康检查仪表盘
```

- 构建使用 `build.ts`（Bun.build API + 代码分割 + Node.js 兼容补丁），将 Anthropic 内部包标记为 external 并用 stubs 替代
- 构建失败时（缺失模块），运行 `bun run scripts/create-stubs.ts` 自动解析错误并生成 stub 文件

## 关键目录和文件

| 路径 | 说明 |
|------|------|
| `src/` | 逆向的 Claude Code TypeScript/TSX 源码 |
| `stubs/` | Anthropic 内部模块的 stub 替代文件 |
| `scripts/create-stubs.ts` | 迭代构建、解析错误、自动生成缺失模块 stub |
| `analysis/` | Claude Code 内部架构深度分析文档（见下方索引） |
| `.claude/hooks/security-check.sh` | 统一安全检查脚本（220 行，3 种模式） |
| `.claude/commands/sync-upstream.md` | Skill：追踪官方 CHANGELOG 变化并生成同步报告 |
| `.claude/settings.local.json` | Claude Code 权限配置 + PreToolUse 安全 hook |
| `SYNC.md` | 官方版本与本地实现的功能差距追踪 |
| `build.ts` | 构建脚本（define/external/createRequire 补丁） |
| `biome.json` | Biome 代码检查配置（宽松模式，适配反编译代码） |
| `scripts/health-check.ts` | 项目健康仪表盘（依赖/构建/测试/lint/hooks） |
| `.github/workflows/ci.yml` | GitHub Actions CI（lint → test → build） |
| `.editorconfig` | 跨编辑器格式统一 |

## 分析文档索引

`analysis/` 目录包含 Claude Code 内部架构的详细研究。在相关领域工作时参考这些文档：

- `analysis/module-overview.md` — 全模块总览（31 个目录 + 6 个核心文件）
- `analysis/_module-map.md` / `_module-map.json` — 模块依赖图（人类可读 + 机器可读）
- `analysis/_dependency-graph.md` — 完整依赖矩阵和交互路径
- `analysis/feature/agent-main-loop.md` — Agent 双循环架构（外层 REPL + 内层 queryLoop）
- `analysis/feature/agent-sdk-relationship.md` — Agent SDK 是 CLI 的子进程包装 + NDJSON 协议
- `analysis/feature/agent-teams.md` — 多 Agent/Swarm 系统（InProcess/Tmux/iTerm2 三种后端）
- `analysis/feature/compression.md` — 上下文压缩（4 种触发 + 3 种策略）
- `analysis/feature/tool-system.md` — 工具注册、执行管线、权限系统、MCP 集成

## 功能同步状态

`SYNC.md` 记录官方 Claude Code 每个版本的变更条目及本地实现状态（✅/⚠️/❌/➖）。
运行 `/sync-upstream` 可检查新版本并自动更新。在开发相关功能前，先查看 SYNC.md 了解当前差距。

## CI/CD

GitHub Actions 在 push/PR 到 main 时自动运行：
1. `bun install --frozen-lockfile` — 安装依赖
2. `bun run lint` — Biome 代码检查
3. `bun test` — 运行测试
4. `bun run build` — 构建验证

配置文件：`.github/workflows/ci.yml`

## 安全 Hooks

三层保护机制，均由 `.claude/hooks/security-check.sh` 统一处理：

1. **Claude Code PreToolUse hook**（`.claude/settings.local.json`）— 拦截所有 Bash 调用，检查 git commit（secrets/敏感文件/大文件）、git push（禁止 force push）、git reset --hard
2. **Git pre-commit hook**（`.git/hooks/pre-commit`）— 先运行安全检查（secrets/敏感文件/大文件/archive 保护），再运行 Biome lint 检查 staged .ts/.tsx 文件
3. **Git pre-push hook**（`.git/hooks/pre-push`）— 保护 archive 分支

脚本使用 `git rev-parse --show-toplevel` 定位仓库根目录，在 worktree 中也能正确工作。

## Worktree 并行工作

支持 git worktree 实现多个 Claude Code 会话并行开发。

```bash
# 创建 worktree（从 main 分出 feature 分支）
git worktree add ../claude-code-<name> -b feature/<name>

# 每个 worktree 需独立初始化
cd ../claude-code-<name>
bun install
bun run build
```

**自动共享**：Git hooks（`.git/hooks/`）、Git 配置和引用
**各自独立**：工作树文件、`node_modules/`、`dist/`、未追踪文件

完成后合并回 main 并清理：
```bash
git worktree remove ../claude-code-<name>
```

## 约定

- Commit 消息：小写开头、祈使句、描述性（如 `add sync-upstream skill and initial sync state`）
- 代码和 commit 用英文，文档可用中文
- 永远不要提交 API key、token、密钥等敏感信息（安全 hook 会拦截）
- 构建报错缺失模块时，优先用 `scripts/create-stubs.ts` 自动生成 stub
- 架构分析文档放在 `analysis/` 目录下
