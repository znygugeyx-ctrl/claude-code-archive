# Agent Teams (Swarm) 深度分析

> 分析范围：`src/utils/swarm/`、`src/utils/teammate*.ts`、`src/coordinator/`、`src/tasks/InProcessTeammateTask/`、`src/tasks/RemoteAgentTask/` 等
> 源码标注格式：`[文件路径:行号]`

---

## 一、功能定位

Agent Teams（代码内称 **Swarm**）是 Claude Code 的多 Agent 协作系统。它允许一个 **Leader Agent**（用户直接交互的主会话）动态创建若干 **Teammate Agent**，各自在独立上下文中并发执行子任务，最终由 Leader 汇总结果。

核心能力：
- **并行执行**：多个 Teammate 同时工作，互不阻塞
- **任务分发**：Leader 通过消息或任务列表给 Teammate 分配工作
- **隔离安全**：Teammate 的文件写入权限需经 Leader 审批
- **弹性后端**：根据运行环境自动选择执行方式（终端分屏 or 进程内）

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户 (Terminal)                           │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                      Leader Agent (main.tsx)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │ QueryEngine  │  │  TeammateTool│  │  TeamsDialog (UI)   │   │
│  │  (LLM循环)   │  │  (spawn触发) │  │  (权限/状态展示)     │   │
│  └──────┬───────┘  └──────┬───────┘  └─────────────────────┘   │
└─────────┼─────────────────┼─────────────────────────────────────┘
          │                 │
          │          ┌──────▼────────────────────┐
          │          │   BackendRegistry          │
          │          │  (自动选择执行后端)         │
          │          └──────┬────────────────────┘
          │                 │
          │    ┌────────────┼────────────┐
          │    ▼            ▼            ▼
          │ InProcess    Tmux          iTerm2
          │ Backend      Backend       Backend
          │    │            │            │
          │    └────────────┴────────────┘
          │                 │ spawn
          │    ┌────────────┼────────────────────────┐
          │    │            │                         │
          │    ▼            ▼                         ▼
          │  Teammate A  Teammate B  ...          Teammate N
          │  (同进程)    (tmux pane)              (iTerm2 pane)
          │
          │  ◄────── 文件系统 Mailbox ──────►
          │          ~/.claude/teams/{name}/inboxes/
```

---

## 三、三种执行后端

这是整个系统最核心的设计决策。代码用 **Backend 注册表 + 策略模式** 统一三种完全不同的执行环境。

### 3.1 后端类型

| 后端 | 标识 | 执行方式 | 要求 |
|------|------|---------|------|
| **InProcess** | `'in-process'` | 同 Node.js 进程，AsyncLocalStorage 隔离 | 无（始终可用） |
| **Tmux** | `'tmux'` | 独立 tmux pane，各自一个 OS 进程 | 系统安装 tmux |
| **iTerm2** | `'iterm2'` | iTerm2 原生分屏，各自独立进程 | macOS + `it2` CLI |

### 3.2 后端选择逻辑

[`src/utils/swarm/backends/registry.ts`]

```
优先级（从高到低）：
1. 环境变量 CLAUDE_CODE_TEAMMATE_MODE=in-process → 强制 in-process
2. 非交互式会话（-p flag）                       → 强制 in-process
3. 环境变量 CLAUDE_CODE_TEAMMATE_MODE=tmux        → 强制 tmux
4. 自动检测：
   - 在 tmux 内 → TmuxBackend
   - 在 iTerm2 内 + it2 可用 → ITermBackend
   - 否则 → InProcessBackend（降级）
```

registry 用**懒加载**导入 TmuxBackend 和 ITermBackend [registry.ts:~50]，避免循环依赖和启动开销。

### 3.3 统一执行器接口

[`src/utils/swarm/backends/types.ts:170+`]

所有后端实现 `TeammateExecutor` 接口：

```typescript
interface TeammateExecutor {
  spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>
  sendMessage(agentId: string, message: string): Promise<void>
  terminate(agentId: string, reason?: string): Promise<void>  // 优雅关闭
  kill(agentId: string): Promise<void>                        // 强制终止
  isActive(agentId: string): Promise<boolean>
}
```

Pane 类后端还额外实现 `PaneBackend` 接口，负责终端窗格的创建、布局、颜色标注。

### 3.4 Tmux 后端的窗外会话设计

[`src/utils/swarm/backends/TmuxBackend.ts`]

一个值得关注的细节：如果 Leader 本身**不在 tmux 内**运行，Tmux 后端会创建一个名为 `claude-swarm-{PID}` 的**独立外部 tmux 会话**，使用专属 socket，与用户自己的 tmux 配置完全隔离。这避免了 swarm 操作污染用户的 tmux 环境。

```
场景 A（在 tmux 内）：
  TMUX socket → 直接在当前 session 创建 pane

场景 B（不在 tmux 内）：
  新建 socket: /tmp/tmux-{uid}/claude-swarm-{PID}
  新建 session: claude-swarm
  Teammates 显示在这个独立 session 中
```

---

## 四、身份标识系统

每个 Agent 有三层身份：`agentId`（唯一标识）、`agentName`（显示名）、`teamName`（团队名）。

[`src/utils/teammate.ts`]

### 4.1 三层解析优先级

```
优先级 1：AsyncLocalStorage（TeammateContext）
  - 仅用于 in-process 模式
  - 通过 runWithTeammateContext() 注入
  - 每个 async task chain 各自隔离

优先级 2：dynamicTeamContext 模块变量
  - 用于 tmux/iTerm2 模式（新进程启动时）
  - 通过 setDynamicTeamContext() 设置
  - 从 CLI flags 解析：--agent-id、--agent-name、--team-name

优先级 3：环境变量（兜底）
  - CLAUDE_CODE_AGENT_ID
  - CLAUDE_CODE_AGENT_NAME
  - CLAUDE_CODE_TEAM_NAME
```

这套优先级设计使得 in-process 和 pane-based 两种模式可以**共存于同一进程**而互不干扰。

### 4.2 TeammateContext（AsyncLocalStorage 隔离）

[`src/utils/teammateContext.ts`]

```typescript
type TeammateContext = {
  agentId: string           // "researcher@my-team"
  agentName: string         // "researcher"
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string   // Leader 的 session ID
  isInProcess: true
  abortController: AbortController
}
```

通过 `runWithTeammateContext(context, fn)` 包裹每个 Teammate 的整个执行链，任何在调用栈内的 `getTeammateContext()` 都能拿到正确的上下文，不需要显式传参。

---

## 五、Spawn 流程

### 5.1 完整 Spawn 时序

```
Leader (TeammateSpawnTool 或 TeammateTool)
  │
  ├─ buildSpawnConfig(name, prompt, ...)
  │
  ▼
BackendRegistry.getTeammateExecutor()
  │
  ▼
executor.spawn(config)
  │
  ├─ [in-process] spawnInProcessTeammate()
  │     ├─ 创建 TeammateContext（含独立 AbortController）
  │     ├─ 创建 InProcessTeammateTaskState
  │     ├─ 注册到 AppState.tasks
  │     └─ 启动 runInProcessTeammate() 协程
  │
  └─ [pane-based] PaneBackendExecutor.spawn()
        ├─ backend.createTeammatePaneInSwarmView(name, color)
        ├─ 构建 CLI 命令（含 --agent-id 等 flags）
        ├─ backend.sendCommandToPane(paneId, cmd)
        └─ 写初始 prompt 到 Mailbox
```

### 5.2 继承给 Teammate 的 CLI Flags

[`src/utils/swarm/spawnUtils.ts`]

pane-based 模式通过 CLI flags 传递上下文，以下 flags 从 Leader 继承：

```
--dangerously-skip-permissions   （若 Leader 有）
--permission-mode {mode}
--model {model}
--settings {path}
--plugin-dir {dir}               （每个 plugin 一条）
--teammate-mode {auto|tmux|in-process}
```

环境变量继承：`CLAUDECODE`、`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`、`ANTHROPIC_BASE_URL`、`CLAUDE_CONFIG_DIR`、`HTTPS_PROXY` 等。

---

## 六、进程内执行器

in-process 后端是最复杂的部分，也是不依赖外部工具时的默认路径。

### 6.1 主循环（inProcessRunner.ts，1552 行）

[`src/utils/swarm/inProcessRunner.ts`]

```
runInProcessTeammate(config):
  │
  ├─ 初始化 TeammateContext（AsyncLocalStorage）
  ├─ 初始化 agent context（QueryEngine 所需）
  │
  ▼
  MAIN LOOP:
  │
  ├─ [1] 检查 workAbortController（用户按 Escape 终止当前轮）
  │
  ├─ [2] runAgent(currentPrompt)
  │       └─ 完整的 QueryEngine LLM 循环
  │          - 工具调用权限走 createInProcessCanUseTool()
  │          - 进度更新写回 AppState.tasks
  │
  ├─ [3] 标记 isIdle = true
  │       调用 onIdleCallbacks（通知等待者）
  │       发送 idle_notification 到 Leader mailbox
  │
  ├─ [4] 等待下一个 prompt（POLL LOOP，500ms interval）：
  │       - 检查 mailbox 新消息
  │       - 检查团队任务列表（认领未完成任务）
  │       - 处理 shutdown_request
  │       - Leader 直接消息优先于同伴消息
  │
  └─ GOTO [1]
```

### 6.2 工作 Abort vs 生命周期 Abort

这是一个重要的 UX 设计细节 [`InProcessTeammateTask/types.ts`]：

```typescript
// 两个独立的 AbortController：
abortController:            // 整个 Teammate 生命周期（kill 时触发）
currentWorkAbortController: // 仅当前这一轮工作（Escape 键触发）
```

用户按 Escape 只中止当前任务，Teammate 进入 idle 等待下一个 prompt；而 kill 命令才真正终止 Teammate 进程。这保留了"暂停当前任务"和"关闭 Agent"的语义区分。

### 6.3 UI 消息缓存上限

[`inProcessRunner.ts:TEAMMATE_MESSAGES_UI_CAP = 50`]

in-process Teammate 的消息历史在 AppState 中只保留最近 50 条（用于 Leader 界面展示），防止长时间运行的 Agent 无限增长内存占用。完整的对话历史留在 QueryEngine 内部。

---

## 七、文件系统 Mailbox 通信

所有通信——无论 in-process 还是 pane-based——都走**文件系统 Mailbox**，这是系统中最关键的设计决策之一。

### 7.1 目录结构

```
~/.claude/teams/{team-name}/
  ├── config.json                    # TeamFile（团队元数据）
  ├── inboxes/
  │   ├── team-lead.json             # Leader 的收件箱
  │   ├── researcher.json            # Teammate inbox
  │   └── {agent-name}.json
  └── permissions/
      ├── pending/
      │   ├── perm-{id}.json         # 待处理权限请求
      │   └── .lock
      └── resolved/
          └── perm-{id}.json         # 已处理（保留 1 小时）
```

### 7.2 为什么用文件而不用内存 Channel？

[`src/utils/teammateMailbox.ts`] 的设计注释透露了理由：

1. **进程崩溃恢复**：文件持久化，重启后 Teammate 仍能读到队列中的消息
2. **跨进程统一**：pane-based 和 in-process 使用同一套通信机制
3. **会话恢复**：恢复历史会话时，pending 消息不会丢失
4. **多实例兼容**：同一机器上多个 Claude 实例可以通过文件系统协作

代价是需要文件锁（lockfile 库）防止并发写入冲突，以及 500ms 轮询延迟。

### 7.3 消息协议

[`src/utils/teammateMailbox.ts`]

Mailbox 消息分两类：

**普通文本消息**（Agent 间对话）：
```typescript
type TeammateMessage = {
  from: string
  text: string
  timestamp: string     // ISO 8601
  read: boolean
  color?: string        // 发送者 UI 颜色
  summary?: string      // 5-10 字摘要（用于 Leader UI badge）
}
```

**结构化协议消息**（JSON 嵌入 text 字段）：

| 消息类型 | 方向 | 用途 |
|---------|------|------|
| `permission_request` | Teammate → Leader | 申请执行某工具（写文件、运行命令等） |
| `permission_response` | Leader → Teammate | 允许/拒绝权限请求 |
| `sandbox_permission_request` | Teammate → Leader | 申请访问某网络地址 |
| `sandbox_permission_response` | Leader → Teammate | 允许/拒绝网络访问 |
| `shutdown_request` | Leader → Teammate | 请求优雅关闭 |
| `shutdown_approved` | Teammate → Leader | 同意关闭 |
| `shutdown_rejected` | Teammate → Leader | 拒绝关闭（含理由） |
| `idle_notification` | Teammate → Leader | 当前任务完成，进入空闲 |
| `plan_approval_request` | Teammate → Leader | Plan 模式：提交计划请求批准 |
| `plan_approval_response` | Leader → Teammate | 批准/拒绝计划 |
| `mode_set_request` | Leader → Teammate | 变更 Teammate 的权限模式 |
| `task_assignment` | Leader → Teammate | 分配任务列表 |
| `team_permission_update` | Leader → Teammate | 更新团队文件写入路径权限 |

---

## 八、权限系统

这是多 Agent 场景中最复杂的问题：Teammate 要写文件时，谁来批准？

### 8.1 三条权限路径

[`src/utils/swarm/permissionSync.ts`、`leaderPermissionBridge.ts`]

```
Teammate 工具调用需要权限
        │
        ├─ [路径 A] in-process + Leader UI 在线
        │   ↓
        │   setToolUseConfirmQueue（直接推入 Leader 的 UI 确认队列）
        │   Leader 的 ToolUseConfirmDialog 弹出（带 Teammate 颜色标识）
        │   用户点击 Allow/Deny → 回调
        │
        ├─ [路径 B] in-process + Leader UI 不可用（headless）
        │   ↓
        │   创建 permission_request 消息 → 写入 Leader mailbox
        │   Teammate 轮询自己 mailbox 等待 permission_response（500ms）
        │   Leader 读取 → 决定 → 写 permission_response 回 Teammate mailbox
        │
        └─ [路径 C] pane-based（独立进程）
            ↓
            只能走 mailbox（路径 B）
```

路径 A 是 in-process 模式的性能优化：直接共享 Leader 的 UI 状态，跳过文件 I/O，批准延迟从 ~500ms 降到毫秒级。

### 8.2 计划模式（Plan Mode）

[`src/utils/swarm/inProcessRunner.ts`，`src/utils/swarm/permissionSync.ts`]

Teammate 可以设置 `planModeRequired: true`，此时：

1. Teammate 启动后自动进入 Plan 模式（只能读不能写）
2. 完成分析后发送 `plan_approval_request` 给 Leader
3. Leader UI 展示计划，用户审核
4. 用户批准 → `plan_approval_response` → Teammate 退出 Plan 模式开始执行
5. 用户拒绝 → Teammate 等待新指令

### 8.3 团队路径白名单（TeamAllowedPath）

[`src/utils/swarm/teamHelpers.ts`、`TeamFile`]

Leader 可以为整个团队设置预授权路径：

```typescript
type TeamAllowedPath = {
  path: string       // 允许写入的目录
  toolName: string   // 允许的工具（如 "Edit"、"Write"）
  addedBy: string    // 谁添加的
  addedAt: number
}
```

Teammate 在这些路径下执行对应工具时无需每次申请权限。路径在 Teammate 加入团队时下发，存储在 `TeamFile.teamAllowedPaths`。

---

## 九、TeamFile：团队状态持久化

[`src/utils/swarm/teamHelpers.ts:TeamFile`]

团队所有状态持久化在 `~/.claude/teams/{team-name}/config.json`：

```typescript
type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string          // Leader 的 agent ID
  leadSessionId?: string       // Leader 的 session UUID
  hiddenPaneIds?: string[]     // 隐藏的 Teammate pane IDs
  teamAllowedPaths?: TeamAllowedPath[]

  members: Array<{
    agentId: string            // "researcher@my-team"
    name: string
    agentType?: string         // 角色（researcher/tester/...）
    model?: string             // 专属模型（可不同于 Leader）
    prompt?: string            // 初始任务
    color?: string
    planModeRequired?: boolean
    joinedAt: number
    tmuxPaneId: string
    cwd: string                // 工作目录
    worktreePath?: string      // Git worktree 路径
    sessionId?: string         // Teammate 的 session UUID
    subscriptions: string[]    // mailbox 订阅列表
    backendType?: BackendType
    isActive?: boolean         // 是否在工作（非 idle）
    mode?: PermissionMode      // 当前权限模式
  }>
}
```

持久化 TeamFile 使得：
- 进程崩溃重启后能恢复团队状态
- `teamDiscovery.ts` 可在同机器上发现其他运行中的团队
- 断线重连（`reconnection.ts`）能找回失联的 Teammate

---

## 十、布局管理

[`src/utils/swarm/teammateLayoutManager.ts`]

pane-based 模式下，多个 Teammate 的终端窗格布局遵循固定策略：

```
单个 Teammate：
┌─────────────┬─────────────┐
│             │             │
│   Leader    │  Teammate   │
│   (左30%)   │   (右70%)   │
│             │             │
└─────────────┴─────────────┘

多个 Teammate：
┌─────────────┬─────────────┐
│             │  Teammate A │
│   Leader    ├─────────────┤
│   (左30%)   │  Teammate B │
│             ├─────────────┤
│             │  Teammate C │
└─────────────┴─────────────┘

Pane 颜色标识：
- 每个 Teammate 分配独立颜色（由 agentColorManager 管理）
- Tmux pane border 着色（tmux ≥ 3.2）
- Pane 标题显示 Teammate 名称
```

"隐藏"功能 (`hidePane`) 把 Teammate pane 移到名为 `claude-hidden` 的独立 tmux window，`showPane` 再移回来——既保持 Teammate 运行，又不占用主视图空间。

---

## 十一、Coordinator 模式

[`src/coordinator/coordinatorMode.ts`，369 行]

Coordinator 是一种特殊的 Leader 角色：它自身不执行代码任务，只负责：

1. **分解任务**：将复杂任务拆解为子任务
2. **分配工作**：通过 `TeammateTool` spawn Teammate 并分配任务
3. **汇总结果**：等待所有 Teammate 完成，整合输出
4. **工具限制**：Coordinator 的可用工具集被精简——移除文件编辑类工具，仅保留团队管理和消息工具

`coordinatorMode.ts` 负责检测当前 Agent 是否处于 Coordinator 角色，并相应地调整工具集和系统 Prompt 附加内容。

---

## 十二、Idle 通知与等待机制

[`src/tasks/InProcessTeammateTask/`、`src/utils/swarm/inProcessRunner.ts`]

Leader 有时需要等待所有 Teammate 完成当前任务（如执行最终汇总前）。系统用**回调 + Promise**实现：

```
Leader: waitForTeammatesToBecomeIdle()
  ├─ 找到所有 status=running 且 isIdle=false 的 Teammate
  ├─ 在每个 Teammate 的 task 上注册 onIdleCallback
  └─ 返回 Promise，等待所有回调触发

Teammate: 当前轮 LLM 循环结束
  ├─ task.isIdle = true
  ├─ 发送 idle_notification 到 Leader mailbox（包含 summary 和完成状态）
  └─ 触发所有已注册的 onIdleCallbacks

Leader Promise resolve → 继续下一步
```

`IdleNotificationMessage` 还携带 `idleReason`（`'available'`/`'interrupted'`/`'failed'`）、`completedTaskId` 和 `failureReason`，让 Leader 能区分正常完成、中断和失败。

---

## 十三、Git Worktree 集成

Teammate spawn 时可以指定 `worktreePath`，系统会：

1. 在主 repo 创建 git worktree（隔离的工作分支）
2. Teammate 在 worktree 目录下启动（独立文件系统视图）
3. Teammate 的修改不影响主分支，直到 Leader 决定 merge
4. 会话结束时清理 worktree（`cleanupSessionTeams` → `git worktree remove`）

这使得多个 Teammate 可以**并行修改同一 repo 的不同特性分支**而不产生冲突。

---

## 十四、关键设计决策总结

| 决策 | 选择 | 原因 |
|------|------|------|
| 进程内隔离方案 | AsyncLocalStorage | 比线程局部存储更简洁，无需跨线程传参；Node.js async 原生支持 |
| 通信机制 | 文件系统 Mailbox | 跨进程统一、崩溃恢复、会话续做；代价是 500ms 轮询延迟 |
| 后端抽象 | Strategy 模式 + 注册表 | 三种后端行为差异极大，统一接口后上层代码无需关心具体实现 |
| 两级 AbortController | 分离 work/lifecycle | 保留"暂停当前任务"和"关闭 Agent"的语义区分，UX 更清晰 |
| 消息 UI 上限 50 条 | 裁剪内存 | 分析显示 500+ 轮对话约 20MB/Agent，长期运行无法接受 |
| Tmux 外部 socket | `claude-swarm-{PID}` | 隔离 swarm 操作，不污染用户既有 tmux 配置 |
| 计划模式审批 | 文件 mailbox + Leader UI | 高风险任务在执行前强制 human-in-the-loop |

---

## 十五、数据流全景（端到端）

```
① 用户："/team create researcher"
         ↓
② Leader QueryEngine → TeammateSpawnTool.call()
         ↓
③ BackendRegistry.getTeammateExecutor() → 选后端
         ↓
④ executor.spawn(config)
   ├─ [in-process] 创建 TeammateContext + InProcessTeammateTaskState
   │                启动 runInProcessTeammate() 协程
   └─ [pane] 创建 tmux/iTerm2 pane，发送 CLI 命令启动新 Claude 进程
         ↓
⑤ Teammate 启动，读 mailbox 中的初始 prompt
         ↓
⑥ Teammate QueryEngine 开始工作（FileEdit、Bash 等工具）
   - 需要权限 → mailbox permission_request → Leader UI → mailbox permission_response
   - 需要 Leader 指导 → SendMessageTool → mailbox 普通消息
         ↓
⑦ Teammate 任务完成 → isIdle=true → mailbox idle_notification
         ↓
⑧ Leader 收到 idle_notification → onIdleCallbacks → 汇总所有 Teammate 输出
         ↓
⑨ 用户："/team shutdown"
         ↓
⑩ Leader → mailbox shutdown_request → Teammate 决定 approve/reject
   → 清理：kill pane + destroy worktree + 删除 team 目录
```

---

*源码主要分布：`src/utils/swarm/`（~7200 行）、`src/utils/teammate*.ts`（~1700 行）、`src/coordinator/coordinatorMode.ts`（369 行）、`src/tasks/InProcessTeammateTask/`*
