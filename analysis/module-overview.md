# Claude Code 模块总览

> 生成于 2026-03-31
> 用途：各模块职责速查 + 后续深度分析的导航索引

---

## 项目定位

Claude Code 是 Anthropic 官方 CLI，将 Claude LLM 能力嵌入终端工作流。其核心设计是一个 **Agent 循环**：用户输入 → LLM 推理 → 工具调用 → 结果反馈 → 继续推理，直到任务完成。

**技术栈**：TypeScript + Bun 运行时 + React + Ink（终端 UI）

**规模**：~1,884 文件，~513K 行，31 个模块目录 + 若干顶层核心文件

---

## 架构鸟瞰

```
┌──────────────────────────────────────────────────────────────┐
│                   用户 / IDE / 远程客户端                       │
└──────────────────────────────────────────────────────────────┘
              │ 命令行输入          │ IDE WebSocket
              ↓                    ↓
┌─────────────────────┐   ┌─────────────────────┐
│     main.tsx        │   │      bridge/         │
│  (UI 编排 + Ink)    │   │  (IDE 桥接层)         │
└──────────┬──────────┘   └──────────┬──────────┘
           │                          │
           ↓                          ↓
┌──────────────────────────────────────────────────┐
│                  命令层 / 工具层                    │
│    commands.ts ←──→ QueryEngine.ts ←──→ tools.ts  │
│    (命令注册)       (LLM 主循环)      (工具注册)    │
└──────────────────────────────────────────────────┘
           │
           ↓
┌──────────────────────────────────────────────────┐
│               服务层 + 基础设施层                   │
│   services/  utils/  memdir/  context/  state/    │
└──────────────────────────────────────────────────┘
           │
           ↓
┌──────────────────────────────────────────────────┐
│                  类型 / 常量层                      │
│              types/  constants/  native-ts/        │
└──────────────────────────────────────────────────┘
```

---

## 顶层核心文件（非模块目录）

这些文件是系统骨架，分析时应优先阅读。

### `src/main.tsx` (~800KB 编译后)
**定位**：整个应用的顶层编排，Ink UI 渲染根节点。

负责：
- 解析 CLI 参数（Commander.js），路由到不同运行模式（interactive REPL、headless、server、bridge 等）
- 启动 React + Ink 渲染循环，渲染 `<App />` 组件树
- 初始化权限系统、插件、技能、MCP 服务器
- 管理主会话生命周期（创建、恢复、持久化）
- 处理全局信号（Ctrl+C、SIGTERM）

理解这个文件就理解了整个系统的启动流程和运行模式切换。

---

### `src/QueryEngine.ts` (~47KB)
**定位**：LLM 对话的核心引擎，Agent 循环的驱动器。

负责：
- 接收用户消息，构建发送给 Claude API 的完整请求（系统 Prompt + 历史消息 + 工具定义）
- 处理流式响应：文本块直接渲染，工具调用块触发工具执行
- 工具调用的权限检查 → 执行 → 结果回填 → 继续下一轮 LLM 调用（递归循环）
- Token 预算管理和成本跟踪
- 集成记忆系统（`memdir/`）构建上下文
- 错误处理和重试（API 错误、工具执行失败）

这是整个 Agent 能力的核心，所有智能行为都从这里触发。

---

### `src/query.ts` (~68KB)
**定位**：查询执行与消息处理的中间层。

负责：
- 处理用户输入（文本解析、@mention 文件引用、图片附件）
- 构建发送给 QueryEngine 的消息对象
- 处理 slash 命令的前置路由（本地命令优先，AI 命令次之）
- 管理消息历史的压缩（长上下文截断）

---

### `src/Tool.ts` (~29KB)
**定位**：工具系统的基础抽象，所有工具的父类和类型定义。

负责：
- 定义工具的接口契约：`name`、`description`、`inputSchema`（JSON Schema）、`call()`
- 工具调用的通用流程：参数验证 → 权限检查 → 执行 → 输出格式化
- 工具调用结果的类型系统（`ToolResult`）

---

### `src/tools.ts` (~17KB)
**定位**：工具注册中心，把 `src/tools/` 下的所有工具聚合为一个列表。

负责：
- 按运行模式（interactive/headless/server）动态选择激活的工具集
- 动态注册 MCP 工具和 Skill 工具

---

### `src/commands.ts` (~25KB)
**定位**：命令执行框架，把 `src/commands/` 下的所有 slash 命令聚合并提供查找/执行能力。

---

### `src/cost-tracker.ts` (~10KB)
**定位**：Token 用量和 API 成本的跟踪器，贯穿整个会话生命周期。

---

## 模块详解

### 1. `src/utils/` — 基础工具库

**规模**：~564 文件，~180K 行，32 个子目录（最大模块）

**定位**：整个项目的基础设施层，提供所有横切关注点。几乎每个其他模块都依赖它。

**核心子模块：**

| 子目录/文件 | 职责 |
|------------|------|
| `settings/` | 配置文件读写、Zod 验证、MDM（企业设备策略）、远程配置同步、变更监听 |
| `permissions/` | 工具调用权限系统：权限模式（AUTO/需授权/拒绝）、每工具每会话白名单、企业策略 |
| `plugins/` | 插件安装/加载/缓存/版本管理，内置插件 vs 用户安装插件的管理 |
| `model/` | 模型选择逻辑、上下文窗口计算、模型弃用警告、模型字符串解析 |
| `messages.ts` | 消息序列化/反序列化，Anthropic API 消息格式与内部格式的相互转换 |
| `git/` | Git 操作封装：分支检测、Worktree 管理、提交、diff 生成、.gitignore 解析 |
| `swarm/` | 多 Agent 协调的底层支持：Swarm 后端、Teammate 模式快照、重连机制 |
| `skills/` | 技能目录监听、技能文件加载、Skill 变更热重载 |
| `hooks.ts` | Claude Code Hooks 系统：在工具调用前/后执行用户自定义 shell 脚本 |
| `bash/` | Bash 命令执行封装、shell 脚本生成、环境变量处理 |
| `sessionStorage.ts` | 会话持久化（消息历史、工具调用记录），跨进程恢复 |
| `claudemd.ts` | CLAUDE.md 文件解析和层级合并（项目级/用户级/企业级配置文档） |
| `tokens.ts` / `modelCost.ts` | Token 计算和 API 成本估算 |
| `ansiToPng.ts` | 终端 ANSI 输出转 PNG（用于截图/分享） |
| `status.tsx` | 状态栏显示逻辑 |
| `mcp/` | MCP 相关工具函数（补充 services/mcp/ 的通用逻辑） |
| `cronScheduler.ts` | Cron 任务调度器（后台定时任务） |

**分析建议**：这个模块太大，建议按子目录分批分析。优先顺序：`settings/` → `permissions/` → `messages.ts` → `plugins/` → `hooks.ts`

---

### 2. `src/services/` — 外部服务集成层

**规模**：~130 文件，~53K 行，38 个子目录

**定位**：所有外部系统集成的适配层。核心是 Claude API 调用和 MCP 协议，其余是各类扩展服务。

**核心子模块：**

| 子目录 | 职责 |
|--------|------|
| `api/` (~22 文件) | **最重要**：Claude API HTTP 客户端、流式请求处理、认证、日志、文件上传 API |
| `mcp/` (~25 文件) | MCP（Model Context Protocol）完整实现：服务器管理、资源发现、工具转换、XAA 认证 |
| `analytics/` (~11 文件) | 用户行为事件日志、GrowthBook 特性开关、Datadog 监控 |
| `lsp/` (~9 文件) | Language Server Protocol 集成：代码补全、诊断、跳转定义等 IDE 功能 |
| `compact/` (~13 文件) | 长对话消息压缩：当上下文窗口接近上限时，智能压缩历史消息 |
| `plugins/` (~5 文件) | 插件 CLI 管理命令（安装/卸载/检查）的服务端逻辑 |
| `oauth/` (~7 文件) | OAuth 2.0 认证流程、令牌刷新、PKCE |
| `extractMemories/` | 从对话中自动提取记忆，写入 MEMORY.md |
| `SessionMemory/` + `teamMemorySync/` | 会话记忆持久化 + 团队间记忆同步 |
| `remoteManagedSettings/` | 企业远程配置推送和执行 |
| `policyLimits/` | API 使用策略检查和限制执行 |
| `VCR/` | 请求录制回放（用于测试） |

**分析建议**：`api/` 和 `mcp/` 是最核心的，`compact/` 的压缩策略很有技术价值。

---

### 3. `src/tools/` — Agent 工具实现

**规模**：~184 文件，~50K 行，45 个工具目录

**定位**：Claude 可以调用的所有工具的具体实现。每个工具一个目录，包含实现、输入 schema、UI 渲染组件。

**工具分类：**

| 类别 | 工具 | 说明 |
|------|------|------|
| **文件操作** | `FileReadTool` `FileWriteTool` `FileEditTool` `NotebookEditTool` | 读写文件、精确编辑（old/new string 替换）、Jupyter notebook |
| **代码搜索** | `GlobTool` `GrepTool` | 文件名模式匹配、内容正则搜索（基于 ripgrep） |
| **Shell 执行** | `BashTool` `PowerShellTool` `REPLTool` | 在沙盒中执行 shell 命令，支持持久 REPL 会话 |
| **AI 协作** | `AgentTool` `SkillTool` | 调用子 Agent（递归）、调用用户定义的 Skill |
| **MCP 集成** | `MCPTool` `ListMcpResourcesTool` `ReadMcpResourceTool` | 调用 MCP 服务器工具、列举和读取 MCP 资源 |
| **网络** | `WebFetchTool` `WebSearchTool` | HTTP 请求、网页搜索 |
| **任务管理** | `TaskCreateTool` `TaskUpdateTool` `TaskListTool` `TaskGetTool` `TaskStopTool` `TaskOutputTool` | 后台异步任务的全生命周期管理 |
| **工作空间** | `EnterWorktreeTool` `ExitWorktreeTool` `EnterPlanModeTool` `ExitPlanModeTool` | Git Worktree 切换、计划模式开关 |
| **通信** | `SendMessageTool` `AskUserQuestionTool` | 向用户发送消息、向用户提问并等待回答 |
| **IDE** | `LSPTool` | 通过 LSP 获取代码诊断、补全建议 |
| **系统** | `SyntheticOutputTool` `ConfigTool` `BriefTool` `RemoteTriggerTool` | 合成输出、运行时配置查询、触发远程动作 |

**分析建议**：`BashTool`（安全沙盒设计）、`FileEditTool`（精确编辑实现）、`AgentTool`（子 Agent 递归调用）最有技术价值。

---

### 4. `src/commands/` — CLI 斜杠命令

**规模**：~189 文件，~26K 行，103 个命令目录

**定位**：用户通过 `/command` 形式调用的所有本地命令实现。与 tools 的区别：命令由用户直接触发，工具由 LLM 触发。

**命令分类：**

| 类别 | 典型命令 | 说明 |
|------|---------|------|
| **会话管理** | `session` `resume` `memory` | 查看/恢复历史会话，管理 MEMORY.md |
| **代码操作** | `review` `commit` `diff` `branch` | 代码审查、git 提交、分支管理 |
| **配置** | `config` `settings` `theme` `output-style` `keybindings` | 各类用户配置项管理 |
| **系统诊断** | `doctor` `status` `usage` `debug-tool-call` | 环境检查、用量查看、工具调试 |
| **安装集成** | `install` `ide` `desktop` `chrome` `mobile` | 各平台安装向导 |
| **扩展管理** | `plugin` `mcp` `skills` | 插件/MCP/技能的增删改查 |
| **AI 工作流** | `advisor` `plan` `tasks` `insights` | AI 辅助工作流 |
| **第三方集成** | `github` `slack` `teleport` | GitHub PR/issue、Slack 通知 |
| **输入模式** | `voice` `vim` | 语音输入、Vim 键位模式 |
| **Agent** | `bridge` `agents` | Bridge 会话管理、Agent 管理 |

**分析建议**：`install.tsx`（安装流程 39KB）、`doctor/`（环境诊断）、`github/`（GitHub 集成）值得关注。

---

### 5. `src/components/` — React Ink UI 组件库

**规模**：~389 文件，~81K 行，146 个组件

**定位**：所有终端 UI 的 React 组件。基于 [Ink](https://github.com/vadimdemedes/ink)（React 渲染器，目标是 TTY 而非 DOM）构建。

**核心组件：**

| 组件/目录 | 职责 |
|----------|------|
| `App.tsx` | 顶层应用组件，渲染主 REPL 界面 |
| `BaseTextInput.tsx` | 终端文本输入控件基础实现（光标、历史、自动补全） |
| `ConsoleOAuthFlow.tsx` (~79KB) | 完整的 OAuth 授权流程 UI（含二维码、等待轮询） |
| `Feedback.tsx` (~87KB) | 用户反馈收集组件 |
| `ContextVisualization.tsx` (~76KB) | 上下文可视化：显示当前对话使用的文件、工具调用、token 用量 |
| `FileEditToolDiff.tsx` | 文件编辑操作的 diff 预览（编辑前/后高亮对比） |
| `BridgeDialog.tsx` (~34KB) | Bridge 连接的 UI 对话框 |
| `AutoUpdater.tsx` (~30KB) | 自动更新检查和用户确认 UI |
| `agents/` (16 个) | 子 Agent 状态显示：进度、完成状态、错误 |
| `CoordinatorAgentStatus.tsx` | Coordinator 模式下多 Agent 协作状态总览 |
| `HistorySearchDialog.tsx` | 命令历史搜索对话框 |
| `GlobalSearchDialog.tsx` | 全局内容搜索对话框 |
| `design-system/` | 基础设计系统组件（颜色、间距、排版规范） |
| `diff/` | 代码 diff 展示组件（inline/split view） |

**分析建议**：`BaseTextInput.tsx`（终端输入实现细节）、`FileEditToolDiff.tsx`（diff 渲染）、`agents/`（多 Agent UI 设计）。

---

### 6. `src/hooks/` — React 自定义 Hooks

**规模**：~104 文件，~19K 行，87 个 hook

**定位**：封装可复用的有状态逻辑，供 components 和 screens 使用。

**核心 Hooks：**

| Hook | 职责 |
|------|------|
| `useTextInput.ts` | 文本输入状态管理（缓冲区、光标位置、历史导航） |
| `useTypeahead.tsx` (~212KB) | 自动补全/类型提前功能，支持命令、文件路径、@mention |
| `useReplBridge.tsx` (~115KB) | 连接 REPL 和 Bridge 层的核心 hook，处理消息收发 |
| `useIDEIntegration.tsx` | IDE 集成：监听 IDE 的选中代码、文件变更通知 |
| `useIdeSelection.ts` | 同步 IDE 中当前选中的代码片段到对话上下文 |
| `useDiffInIDE.ts` | 在 IDE 中打开 diff 视图 |
| `useDirectConnect.ts` | 直连 Bridge（无需 WebSocket 代理） |
| `useCanUseTool.tsx` (~40KB) | 权限检查 hook：给定工具调用，返回是否需要用户授权 |
| `useGlobalKeybindings.tsx` (~31KB) | 注册全局快捷键（Ctrl+C、Ctrl+R 等） |
| `useSwarmInitialization.ts` | Swarm 多 Agent 模式初始化 |
| `useSwarmPermissionPoller.ts` | 轮询 Swarm 中子 Agent 的权限请求 |
| `useVoice.ts` + `useVoiceIntegration.tsx` | 语音输入的录音、转写、集成到对话流 |
| `useHistorySearch.ts` | 命令历史搜索（Ctrl+R） |
| `useTasksV2.ts` | 后台任务状态管理和通知 |
| `useInboxPoller.ts` (~34KB) | 轮询消息收件箱（用于异步任务完成通知） |

---

### 7. `src/ink/` — Ink 渲染器增强层

**规模**：~96 文件，~19K 行

**定位**：对 Ink（React TTY 渲染器）的封装和增强，处理终端特有的低级操作。

**主要功能：**
- 快捷键绑定的底层注册（区分 raw 模式和普通模式）
- 光标位置精确控制（用于 inline 编辑）
- 终端尺寸变化响应（窗口 resize 事件）
- ANSI 转义码生成（颜色、样式、清屏）
- 分屏布局支持
- 性能优化：减少不必要的 re-render

---

### 8. `src/bridge/` — IDE 桥接层

**规模**：~31 文件，~12K 行

**定位**：将 Claude Code 嵌入 IDE（VS Code、JetBrains）的桥接层。Bridge 模式下，IDE 插件和 CLI 之间通过 WebSocket 通信，CLI 作为 Agent 后端，IDE 提供 UI。

**核心文件：**

| 文件 | 职责 |
|------|------|
| `bridgeMain.ts` (~115KB) | Bridge 主循环：接受 IDE 连接、管理会话、转发消息 |
| `replBridge.ts` (~100KB) | REPL ↔ Bridge 通信协议实现 |
| `remoteBridgeCore.ts` (~39KB) | 远程 Bridge 核心：处理远程会话的建立和维护 |
| `createSession.ts` | 新会话创建（认证、初始化、工作目录设置） |
| `sessionRunner.ts` | 会话运行器：驱动 QueryEngine，将结果序列化发回 IDE |
| `bridgeApi.ts` | Bridge 服务端 REST API 客户端 |
| `jwtUtils.ts` | JWT 令牌生成和验证（IDE ↔ Bridge 认证） |
| `workSecret.ts` | 工作密钥管理（短期会话认证凭证） |
| `trustedDevice.ts` | 可信设备注册（记住已授权的 IDE） |

---

### 9. `src/cli/` — CLI 输入输出层

**规模**：~19 文件，~12K 行

**定位**：最底层的 CLI I/O 处理，负责消息格式化输出（NDJSON/纯文本）和远程 I/O 代理。

**主要功能：**
- `print.ts`：将内部消息对象格式化为用户可读的终端输出
- `structuredIO.ts`：结构化输出模式（NDJSON，供程序化调用）
- `handlers/`：事件处理器（工具调用事件、消息事件等）
- `transports/`：传输层抽象（本地 stdin/stdout vs 远程 WebSocket）
- `remoteIO.ts`：代理远程 I/O，使本地 CLI 可以处理来自 Bridge 的请求
- `update.ts`：自动版本升级检查和执行

---

### 10. `src/skills/` — Skill 技能系统

**规模**：~20 文件，~4K 行

**定位**：用户可自定义的"技能"（Skill）系统，本质是带 YAML frontmatter 的 Markdown 文件，被暴露为 Claude 可调用的工具。

**核心机制：**
- `loadSkillsDir.ts`：扫描 `~/.claude/skills/` 目录，解析每个 Skill 文件
  - Frontmatter 定义 skill 名称、描述、参数 schema
  - 支持 shell 脚本模式（直接执行）和 prompt 模式（作为 system prompt 注入）
  - 支持模型 override（skill 可指定使用不同模型）
- `bundled/`（19 个内置 skill）：项目预置的 skill，如 `update-config`、`simplify`、`claude-api`、`commit`、`frontend-design` 等

**Skill 与 Command 的区别**：Command 是 `/cmd` 形式的用户触发本地函数；Skill 是 AI 可调用的、可组合的提示工程单元。

---

### 11. `src/tasks/` — 后台任务系统

**规模**：~12 文件，~3K 行

**定位**：管理后台异步任务的执行框架。支持 Claude 在后台运行长时间任务（如等待 CI、运行测试），用户可继续做其他事。

**任务类型：**

| 任务类 | 说明 |
|--------|------|
| `LocalMainSessionTask` | 将当前主会话"后台化"（用户按 Ctrl+B 两次） |
| `LocalShellTask` | 在后台执行 Bash 命令，完成后通知 |
| `LocalAgentTask` | 在进程内启动独立 QueryEngine 实例作为子 Agent |
| `RemoteAgentTask` | 在远程机器上运行子 Agent |
| `InProcessTeammateTask` | 进程内的"队友" Agent（Swarm 模式） |
| `DreamTask` | 特殊的梦境任务（实验性功能） |

---

### 12. `src/entrypoints/` — 应用入口点

**规模**：~8 文件，~4K 行

**定位**：定义不同运行模式的入口点和初始化逻辑。

**内容：**
- `init.ts`：通用初始化序列（加载配置、初始化服务、注册信号处理器）
- `sdk/`：Claude Code Agent SDK 的类型定义——第三方开发者嵌入 Claude Code 能力的接口
- MCP 入口点：将 Claude Code 本身作为 MCP 服务器运行

---

### 13. `src/memdir/` — 记忆目录系统

**规模**：~8 文件，~1.7K 行

**定位**：实现 MEMORY.md 持久化记忆机制。Claude Code 可以读写 `~/.claude/memory/` 下的 Markdown 文件，在跨会话间保留上下文。

**核心文件：**
- `memdir.ts`：扫描记忆目录，将相关记忆注入系统 Prompt
- `findRelevantMemories.ts`：语义相关性过滤（避免注入过多无关记忆）
- `memoryTypes.ts`：记忆类型（user/project/feedback/reference）和 frontmatter schema
- `teamMemPaths.ts`：团队共享记忆的路径解析

---

### 14. `src/coordinator/` — 多 Agent 协调模式

**规模**：~1 文件，~369 行

**定位**：实现 Coordinator 模式，一个顶层 Agent 协调多个子 Agent 并行工作。

`coordinatorMode.ts`：
- 检测当前是否处于协调器角色
- 为协调器提供特殊的工具集（管理子 Agent 而不是直接执行任务）
- 控制协调器的权限边界

---

### 15. `src/context/` — React 上下文（UI 状态）

**规模**：~9 文件，~1K 行

**定位**：React Context 的集中定义，管理 UI 层的全局共享状态。

| Context | 职责 |
|---------|------|
| `notifications.tsx` | 通知队列（Toast 通知、错误提示） |
| `mailbox.tsx` | 消息邮箱（模块间异步消息传递） |
| `modalContext.tsx` | 全局模态框状态 |
| `overlayContext.tsx` | 浮层/Overlay 管理 |
| `stats.tsx` | 运行时统计（消息数、工具调用数等） |
| `fpsMetrics.tsx` | 终端渲染帧率监控 |
| `QueuedMessageContext.tsx` | 待发送消息队列 |

---

### 16. `src/state/` — 应用全局状态

**规模**：~6 文件，~1.2K 行

**定位**：更高层的应用级状态管理，在 React 树之外也可访问。

| 文件 | 职责 |
|------|------|
| `AppState.tsx` | AppState React Provider 和顶层状态对象 |
| `AppStateStore.ts` | 状态存储：消息列表、任务列表、通知队列、会话元数据 |
| `store.ts` | 状态创建工厂 |
| `onChangeAppState.ts` | 状态变化副作用处理（如变化时触发持久化） |
| `selectors.ts` | 状态派生值（计算属性） |
| `teammateViewHelpers.ts` | Teammate/Swarm 视图的状态辅助函数 |

---

### 17. `src/screens/` — 全屏 UI 视图

**规模**：~3 文件，~6K 行

**定位**：独立的全屏 UI 视图，占满终端窗口而不是嵌入主 REPL。

| 文件 | 职责 |
|------|------|
| `ResumeScreen.tsx` | 会话恢复选择界面（展示历史会话列表，键盘选择） |
| `DoctorScreen.tsx` | 环境诊断界面（检查 Node、Git、MCP、权限等） |
| `REPLScreen.tsx` | 主 REPL 界面（对话历史、输入框、状态栏的整体布局） |

---

### 18. `src/types/` — TypeScript 类型定义

**规模**：~11 文件，~3.4K 行

**定位**：全局类型定义中心，被所有模块引用。

| 文件 | 核心类型 |
|------|---------|
| `command.ts` | `LocalCommandResult`、`PromptCommand`（slash 命令返回值） |
| `message.ts` | 消息相关类型 |
| `plugin.ts` | `PluginManifest`（插件清单 schema） |
| `permissions.ts` | `PermissionResult`、`PermissionMode` |
| `hooks.ts` | Hooks 系统类型 |
| `logs.ts` | 日志级别和格式类型 |
| `textInputTypes.ts` | 文本输入组件类型 |

---

### 19. `src/constants/` — 全局常量

**规模**：~21 文件，~2.6K 行

**定位**：硬编码常量的集中管理。每类常量一个文件，如 API 端点、模型名称、默认配置值、快捷键名称等。

---

### 20. `src/native-ts/` — 原生 TypeScript 工具

**规模**：~4 文件，~4K 行

**定位**：不依赖任何外部库的纯 TypeScript 工具函数。被 `utils/` 等底层模块使用。

---

### 21. `src/migrations/` — 配置迁移

**规模**：~11 文件，~600 行

**定位**：版本升级时的配置文件迁移脚本，处理旧格式配置的向前兼容。

---

### 22. `src/keybindings/` — 快捷键配置系统

**规模**：~14 文件，~3.2K 行

**定位**：用户自定义快捷键的定义、加载和冲突检测。

---

### 23. `src/vim/` — Vim 键位模式

**规模**：~5 文件，~1.5K 行

**定位**：在终端输入框中支持 Vim 的 Normal/Insert/Visual 模式，实现 Vim 键位绑定。

---

### 24. `src/buddy/` — Buddy 伴侣 UI

**规模**：~6 文件，~1.3K 行

**定位**：轻量级的"伴侣"悬浮 UI 组件，提供快速访问入口（可能是状态栏小组件或 dock 模式显示）。

---

### 25. `src/remote/` — 远程会话

**规模**：~4 文件，~1.1K 行

**定位**：远程会话的基础支持（不同于 Bridge，更轻量的远程连接场景）。

---

### 26. `src/plugins/` — 插件系统核心

**规模**：~2 文件，~182 行

**定位**：轻量的插件系统入口，主要是内置插件的初始化。大部分插件逻辑在 `utils/plugins/` 和 `services/plugins/` 中。

`bundled/`：内置插件集合（如 Playwright 浏览器自动化插件）。

---

### 27. `src/server/` — 服务器运行模式

**规模**：~3 文件，~358 行

**定位**：将 Claude Code 以 HTTP/WebSocket 服务器形式运行，接受外部 API 调用（区别于交互式 CLI 模式）。

---

### 28. `src/upstreamproxy/` — 上游代理配置

**规模**：~2 文件，~740 行

**定位**：企业网络代理配置管理（HTTPS proxy、SOCKS5 proxy），在发出 Claude API 请求时应用代理设置。

---

### 29. `src/bootstrap/` — 启动初始化

**规模**：~1 文件，~1.8K 行

**定位**：应用启动最早期的初始化（全局变量设置、环境检测、Polyfill 注入），在任何业务逻辑运行前执行。

---

### 30. `src/voice/` — 语音输入

**规模**：~1 文件，~54 行

**定位**：语音输入的底层接口定义（具体实现在 `hooks/useVoice.ts` 和 `hooks/useVoiceIntegration.tsx`）。

---

## 模块依赖层次（快速参考）

```
Layer 0 (无依赖):  types/  constants/  native-ts/
Layer 1 (基础):    utils/  state/  context/  bootstrap/
Layer 2 (服务):    services/  memdir/  migrations/  upstreamproxy/
Layer 3 (功能):    tools/  commands/  skills/  tasks/  query/  plugins/
Layer 4 (UI):      hooks/  components/  ink/  screens/  keybindings/  vim/
Layer 5 (网关):    cli/  bridge/  remote/  server/  entrypoints/
Layer 6 (协调):    coordinator/
Layer 7 (引擎):    tools.ts  commands.ts  QueryEngine.ts  query.ts  Tool.ts
Layer 8 (顶层):    main.tsx
```

---

## 推荐深度分析顺序

如果要深入分析，按以下顺序事半功倍（后者理解依赖前者）：

1. `types/` + `constants/` — 了解基础数据结构
2. `Tool.ts` + `tools/` — 理解工具系统（Agent 能力的基础）
3. `services/api/` — 理解 Claude API 调用
4. `QueryEngine.ts` — 理解 Agent 循环核心
5. `utils/permissions/` + `utils/settings/` — 理解权限和配置
6. `bridge/` — 理解 IDE 集成架构
7. `services/mcp/` — 理解 MCP 协议集成
8. `memdir/` + `services/extractMemories/` — 理解记忆系统
9. `tasks/` + `coordinator/` — 理解多 Agent 协调
10. `skills/` — 理解 Skill 系统

---

*分析文件：`analysis/module-overview.md`*
*原始数据：`analysis/_module-map.json` `analysis/_module-map.md` `analysis/_dependency-graph.md`*
