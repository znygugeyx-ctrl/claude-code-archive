# Claude Code Monitor Tool 分析

> 源码路径：`src/tools/MonitorTool/`、`src/tasks/MonitorMcpTask/`、`src/components/tasks/MonitorMcpDetailDialog.ts`、`src/components/permissions/MonitorPermissionRequest/`
> 特性标志：`feature('MONITOR_TOOL')`
> 首发版本：v2.1.98
> 本地代码库版本：v2.1.88（所有实现文件均为 stub）
> npm v2.1.101 逆向：feature flag 在公开构建中为 `false`，实现代码被 DCE

---

## 一、功能总览

Monitor tool 让 Claude 在后台运行一个脚本，将每行 stdout 实时流回对话，使 Claude 无需轮询即可响应外部事件。官方描述：

> "Runs a command in the background and feeds each output line back to Claude, so it can react to log entries, file changes, or polled status mid-conversation."

### 1.1 核心用例

| 用例 | 示例 |
|------|------|
| 追踪日志 | `tail -f /var/log/app.log`，出现错误时 Claude 自动标记 |
| 轮询 CI/PR | 监控 PR 状态变化，通过/失败时自动通知 |
| 监视目录 | `fswatch` 或 `inotifywait` 监听文件变更 |
| 追踪长时间脚本 | 跟踪任意长时间运行脚本的输出 |

### 1.2 平台限制

- ✅ Anthropic API（直连）
- ❌ Amazon Bedrock
- ❌ Google Vertex AI
- ❌ Microsoft Foundry

### 1.3 权限模型

Monitor 使用与 Bash 相同的权限规则。用户为 Bash 设置的 `allow`/`deny` 模式同样适用于 Monitor。有独立的权限请求 UI 组件 `MonitorPermissionRequest`。

### 1.4 生命周期

```
Claude 决定需要监控 → 生成小脚本 → 调用 Monitor tool
→ 后台运行 → 每行 stdout 流回 → Claude 在对话中插入响应
→ 用户要求取消 / 会话结束 → 终止
```

---

## 二、双轨架构

代码库中存在两种 "monitor" 概念，理解这一区分是实现的关键。

### 2.1 MonitorTool + MonitorMcpTask（独立任务轨）

专用工具 `MonitorTool` 生成 `monitor_mcp` 类型的任务。具有：
- 独立的 TaskType（`'monitor_mcp'`）
- 独立的 task ID 前缀（`'m'`）
- 独立的 MonitorMcpTaskState 类型
- 独立的详情对话框（`MonitorMcpDetailDialog`）
- 独立的权限 UI（`MonitorPermissionRequest`）
- 独立的 kill 函数（`killMonitorMcp`、`killMonitorMcpTasksForAgent`）

**推断**：此轨道可能用于 MCP 相关的监控场景（名称中的 "Mcp" 暗示），或是更高层的抽象，由 MonitorTool 内部通过 MCP 协议或直接进程管理实现。

### 2.2 BashTool kind: 'monitor'（Shell 任务变体轨）

`LocalShellTask`（type `'local_bash'`）的 `kind` 字段可设为 `'monitor'`，形成 Shell 监控变体。影响：
- UI 标签：显示 `description` 而非 `command`
- 对话框标题：`"Monitor details"` 而非 `"Shell details"`
- Stall watchdog：monitor kind 直接跳过（不检测交互式输入等待）
- 通知摘要：使用 `Monitor "..." stream ended` / `script failed` / `stopped`
- 折叠行为：monitor 完成通知不折叠进 "N background commands completed"
- Pill 标签：与 shells 分开计数

### 2.3 两轨对比

| 属性 | MonitorMcpTask（独立轨） | LocalShellTask kind:'monitor'（变体轨） |
|------|-------------------------|--------------------------------------|
| TaskType | `'monitor_mcp'` | `'local_bash'` |
| Task ID 前缀 | `'m'` | `'b'` |
| 状态类型 | `MonitorMcpTaskState` | `LocalShellTaskState` |
| Kill 机制 | `killMonitorMcp` | `Q68`（通用 shell kill） |
| Agent 清理 | `killMonitorMcpTasksForAgent` | `killShellTasksForAgent` |
| 详情对话框 | `MonitorMcpDetailDialog` | Shell detail dialog（kind='monitor'标题） |
| Pill 计数 | 单独 "N monitors" | 从 shells 中分离计数 |
| 通知折叠 | 不参与折叠 | 不参与折叠（独立摘要前缀） |

**推断**：两轨很可能协同工作——MonitorTool 的 `call()` 内部通过 LocalShellTask 以 `kind: 'monitor'` 启动后台进程，同时创建 MonitorMcpTask 管理高层状态和事件流。

---

## 三、工具定义（MonitorTool）

当前 `src/tools/MonitorTool/MonitorTool.ts` 为 stub。以下基于集成点和官方文档推断。

### 3.1 推断的 Input Schema

```typescript
// 推断 — 基于官方文档和 BashTool 类比
const inputSchema = z.strictObject({
  command: z.string()
    .describe("The command to run in the background. Each stdout line becomes a notification."),
  description: z.string()
    .describe("Human-readable description of what this monitor watches."),
  timeout: z.number().optional()
    .describe("Optional timeout in milliseconds."),
})
```

依据：
- 官方文档："Claude writes a small script for the watch, runs it in the background"
- `LocalShellSpawnInput` 已有 `command`、`description`、`timeout`、`kind` 字段（`src/Task.ts:59-67`）
- BashTool 的 `kind: 'monitor'` 变体使用相同字段结构
- `BackgroundTasksDialog` 渲染 monitor_mcp 时使用 `_.description`（bundle line 545903）

### 3.2 推断的 Prompt

基于 BashTool prompt 中的 Monitor 说明文本反推：

```
The Monitor tool runs a command in the background and streams each stdout line 
back as a notification. Use it to:
- Tail log files and react to errors as they appear
- Poll CI/PR status and report when it changes  
- Watch directories for file changes
- Track output from any long-running script

Each stdout line from the command becomes a notification that you can react to 
mid-conversation. The user keeps working and you interject when an event lands.

For one-shot "wait until done" scenarios, use Bash with run_in_background instead.
The Monitor tool is for continuous streaming of events.

Stop a monitor by asking the user, or it ends when the session exits.
```

### 3.3 权限

- 与 Bash 共享权限规则
- 独立权限 UI：`MonitorPermissionRequest`（`src/components/permissions/MonitorPermissionRequest/`）
- 在 `PermissionRequest.tsx:73-74` 中分发

### 3.4 与 BashTool 的差异

| 方面 | BashTool run_in_background | MonitorTool |
|------|---------------------------|-------------|
| 用途 | 一次性等待完成 | 持续流式事件 |
| 通知 | 完成时一次性通知 | 每行 stdout 即时通知 |
| sleep | 允许（但 ≥2s 被阻断） | 不需要 sleep |
| 输出 | 写入 output file，完成后读取 | 实时流回对话 |
| 模型引导 | 默认选项 | BashTool prompt 主动引导 |

---

## 四、任务生命周期（MonitorMcpTask）

### 4.1 任务状态类型

当前 stub 未导出 `MonitorMcpTaskState`，但从 `src/tasks/types.ts:9,18,28` 可知它必须满足：
- 包含在 `TaskState` 联合类型中
- 包含在 `BackgroundTaskState` 联合类型中
- 继承 `TaskStateBase`（id, type, status, description, toolUseId, startTime, endTime, outputFile, outputOffset, notified）

```typescript
// 推断的类型定义
export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  description: string
  command?: string
  agentId?: AgentId
  // 可能还有: 事件计数、最后事件时间等
}
```

### 4.2 Task 接口

从 `src/tasks.ts:12-14,30` 和 `Task.ts:72-76` 可知需要导出：

```typescript
export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(taskId: string, setAppState: SetAppState): Promise<void> { ... }
}
```

### 4.3 额外导出

从集成点可知还需要：
- `killMonitorMcp(taskId, setAppState)` — 供 BackgroundTasksDialog 使用（`src/components/tasks/BackgroundTasksDialog.tsx:118`）
- `killMonitorMcpTasksForAgent(agentId, getAppState, setAppState)` — 供 runAgent 使用（`src/tools/AgentTool/runAgent.ts:852`）

### 4.4 生命周期流程

```
MonitorTool.call()
  ├─ 创建 MonitorMcpTask 状态 → registerTask → AppState.tasks
  ├─ spawn 后台进程（command）
  └─ 启动 stdout 逐行读取循环
        │
        ├─ 每行 stdout → enqueueStreamEvent（无 <status> 标签）
        │                 → 作为 task-notification 注入对话
        │                 → Claude 在下一个空闲 turn 响应
        │
        └─ 进程退出
              ├─ 正常退出 → status: 'completed'
              ├─ 异常退出 → status: 'failed'
              └─ 被 kill → status: 'killed'
              → enqueuePendingNotification（有 <status> 标签）
              → 终端通知

Agent 退出时:
  → killMonitorMcpTasksForAgent() 清理所有该 agent 的 monitor
```

---

## 五、事件流式机制

### 5.1 enqueueStreamEvent

这是 Monitor tool 的核心机制。从集成点代码中可推断其行为：

**关键特征：** 不携带 `<status>` 标签。

这一设计决策有深远影响：

1. **不触发 SDK task_notification 事件**（`src/cli/print.ts:2063-2069`）
   ```
   // Only emit a task_notification SDK event when a <status> tag is present
   // — that means this is a terminal notification. Stream events from 
   // enqueueStreamEvent carry no <status> (they're progress pings); 
   // emitting them here would default to 'completed' and falsely close
   // the task for SDK consumers.
   ```

2. **不参与背景通知折叠**（`src/utils/collapseBackgroundBashNotifications.ts:25-37`）
   ```
   // Monitor stream events (enqueueStreamEvent) have no <status> tag 
   // and never match.
   ```

3. **不产生终端状态变更** — 是持续的进度 ping，不是终止信号

### 5.2 与 enqueuePendingNotification 的对比

| 属性 | enqueuePendingNotification | enqueueStreamEvent（推断） |
|------|---------------------------|---------------------------|
| 用途 | 任务完成/失败/终止 | 每行 stdout 实时事件 |
| `<status>` 标签 | ✅ 有 | ❌ 无 |
| SDK 事件 | 触发 task_notification | 不触发 |
| 通知折叠 | 参与（bash 完成折叠为 N 条） | 豁免 |
| 优先级 | `'later'`（或 `'next'` when MONITOR_TOOL） | 推断为 `'next'` 或更高 |
| 模式 | `'task-notification'` | 推断也是 `'task-notification'` |

### 5.3 通知优先级提升

当 `MONITOR_TOOL` 启用时，`enqueuePendingNotification` 的 priority 从 `'later'` 提升为 `'next'`（`src/tasks/LocalShellTask/LocalShellTask.tsx:169`）。

对应 `src/query.ts:1553-1556`：
```
// Drain pending notifications. LocalShellTask completions are 'next'
// (when MONITOR_TOOL is on) and drain without Sleep. Other task types
// (agent/workflow/framework) still default to 'later' — the Sleep flush
// covers those.
```

这意味着启用 Monitor 后，shell 任务完成通知无需等待 Sleep 即可排入对话——整个通知系统响应更快。

---

## 六、集成地图

所有涉及 Monitor tool 的文件及具体位置：

### 6.1 工具与任务注册

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/tools.ts` | 39-41, 237 | MonitorTool 条件加载 + 注入 `getAllBaseTools()` |
| `src/tasks.ts` | 12-14, 30 | MonitorMcpTask 条件加载 + 注入 `getAllTasks()` |
| `src/Task.ts` | 12 | `'monitor_mcp'` 在 `TaskType` 联合类型中 |
| `src/Task.ts` | 59-67 | `LocalShellSpawnInput` 含 `kind?: 'bash' \| 'monitor'` |
| `src/Task.ts` | 85 | Task ID 前缀 `'m'` |

### 6.2 状态类型

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/tasks/types.ts` | 9 | 导入 `MonitorMcpTaskState` |
| `src/tasks/types.ts` | 18 | 包含在 `TaskState` 联合中 |
| `src/tasks/types.ts` | 28 | 包含在 `BackgroundTaskState` 联合中 |
| `src/tasks/LocalShellTask/guards.ts` | 9 | `BashTaskKind = 'bash' \| 'monitor'` |
| `src/tasks/LocalShellTask/guards.ts` | 29-31 | `kind?: BashTaskKind` 及 UI 注释 |

### 6.3 BashTool 交互

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/tools/BashTool/prompt.ts` | 312-314 | 注入 "Use the Monitor tool to stream events..." |
| `src/tools/BashTool/prompt.ts` | 320-327 | 注入 "`sleep N` with N ≥ 2 is blocked..." |
| `src/tools/BashTool/BashTool.tsx` | 322-339 | `detectBlockedSleepPattern()` 函数 |
| `src/tools/BashTool/BashTool.tsx` | 525-531 | `validateInput()` 中 sleep 阻断逻辑 |
| `src/tools/PowerShellTool/PowerShellTool.tsx` | 184-189, 361-367 | PowerShell 版本的相同逻辑 |

### 6.4 LocalShellTask 适配

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/tasks/LocalShellTask/LocalShellTask.tsx` | 47 | stall watchdog 跳过 monitor kind |
| `src/tasks/LocalShellTask/LocalShellTask.tsx` | 129-144 | monitor-kind 专用通知摘要（stream ended/script failed/stopped） |
| `src/tasks/LocalShellTask/LocalShellTask.tsx` | 169 | 通知优先级提升为 `'next'` |

### 6.5 Agent 清理

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/tools/AgentTool/runAgent.ts` | 849-857 | agent 退出时调用 `killMonitorMcpTasksForAgent()` |

### 6.6 权限系统

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/components/permissions/PermissionRequest.tsx` | 40-41 | MonitorTool/MonitorPermissionRequest 条件加载 |
| `src/components/permissions/PermissionRequest.tsx` | 73-74 | `case MonitorTool:` 分发 |

### 6.7 UI 组件

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/components/tasks/BackgroundTasksDialog.tsx` | 117-119 | MonitorMcpTask 模块 + killMonitorMcp 条件加载 |
| `src/components/tasks/BackgroundTasksDialog.tsx` | 392-394 | `case 'monitor_mcp':` 渲染 MonitorMcpDetailDialog |
| `src/tasks/pillLabel.ts` | 17-28 | local_bash kind:'monitor' 分开计数 |
| `src/tasks/pillLabel.ts` | 59-60 | monitor_mcp 专用 pill label |

### 6.8 通知与查询循环

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/utils/collapseBackgroundBashNotifications.ts` | 25-37 | monitor 事件不折叠 |
| `src/cli/print.ts` | 2063-2069 | stream event 不触发 SDK task_notification |
| `src/query.ts` | 1553-1556 | MONITOR_TOOL 启用时通知 drain 无需 Sleep |

---

## 七、UI 组件

### 7.1 MonitorPermissionRequest

**文件**：`src/components/permissions/MonitorPermissionRequest/MonitorPermissionRequest.ts`（stub）

推断行为：类似 `BashPermissionRequest`，但强调 description 而非 command。因为 Monitor 使用与 Bash 相同的权限规则，权限检查逻辑可能直接复用 Bash 的权限匹配器（`preparePermissionMatcher`）。

### 7.2 MonitorMcpDetailDialog

**文件**：`src/components/tasks/MonitorMcpDetailDialog.ts`（stub）

从 `BackgroundTasksDialog.tsx:392-394` 可知接口：
```typescript
<MonitorMcpDetailDialog
  task={task}
  onKill={task.status === 'running' && killMonitorMcp ? () => killMonitorMcp(task.id, setAppState) : undefined}
  onBack={goBackToList}
/>
```

推断内容：显示 monitor 的 description、运行状态、已捕获的事件数/最近事件、output file 内容、kill 按钮。

### 7.3 状态栏 Pill

两种计数方式共存：

1. **`monitor_mcp` 任务**（`pillLabel.ts:59-60`）：`"1 monitor"` / `"N monitors"`
2. **`local_bash` kind:'monitor'**（`pillLabel.ts:17-28`）：从 shells 中分离单独计数

### 7.4 BackgroundTasksDialog

monitor_mcp 任务在 Monitors 分区中显示（bundle line 548419），有 Enter 打开详情、`x` 终止的交互。

---

## 八、与 /loop 和定时任务的关系

### 8.1 动态调度集成

官方定时任务文档明确指出：

> "When you ask for a dynamic `/loop` schedule, Claude may use the Monitor tool directly. Monitor runs a background script and streams each output line back, which avoids polling altogether and is often more token-efficient and responsive than re-running a prompt on an interval."

### 8.2 替代轮询

```
传统 /loop 轮询:
  每 N 分钟 → 重新运行完整 prompt → API 调用 → token 消耗 → 延迟 N 分钟

Monitor 替代:
  一次启动 → 实时流式事件 → 零轮询 → 即时响应
```

### 8.3 Token 效率

- **轮询模式**：每次迭代消耗完整 turn 的 token（system prompt + context + tool calls）
- **Monitor 模式**：启动时消耗一次 token，之后每个事件仅以 task-notification XML 注入（极少 token）
- 对于高频事件场景（如日志 tail），Monitor 的 token 效率远优于轮询

### 8.4 平台降级

在 Bedrock/Vertex/Foundry 上不可用 Monitor，动态 `/loop` 退化为固定 10 分钟间隔的传统轮询。

---

## 九、BashTool 行为变更（MONITOR_TOOL 启用时）

### 9.1 Sleep 阻断

当 `MONITOR_TOOL` 启用时，BashTool 的 `validateInput()` 会检测 `sleep N`（N ≥ 2）作为首个命令的模式：

```typescript
// src/tools/BashTool/BashTool.tsx:525-531
if (feature('MONITOR_TOOL') && !isBackgroundTasksDisabled && !input.run_in_background) {
  const sleepPattern = detectBlockedSleepPattern(input.command);
  if (sleepPattern !== null) {
    return {
      result: false,
      message: `Blocked: ${sleepPattern}. Run blocking commands in the background 
with run_in_background: true — you'll get a completion notification when done. 
For streaming events (watching logs, polling APIs), use the Monitor tool. 
If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.`,
      errorCode: 10
    };
  }
}
```

`detectBlockedSleepPattern`（line 322）捕获 `sleep 5`、`sleep 5 && check`、`sleep 5; check` 但不捕获 subshell/pipeline 内的 sleep 或浮点 sleep（如 `sleep 0.5`）。

### 9.2 Prompt 注入

两条指令注入 BashTool 的 sleep 建议区域（`src/tools/BashTool/prompt.ts:312-327`）：

1. **引导使用 Monitor**：
   > "Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot 'wait until done,' use Bash with run_in_background instead."

2. **阻断长 sleep**：
   > "`sleep N` as the first command with N ≥ 2 is blocked. If you need a delay (rate limiting, deliberate pacing), keep it under 2 seconds."

替代了原有的轮询建议（`"If you must poll an external process, use a check command"` 和 `"If you must sleep, keep the duration short (1-5 seconds)"`）。

### 9.3 通知优先级提升

所有 LocalShellTask 完成通知的优先级从 `'later'` 提升为 `'next'`，使其无需 Sleep tool 即可排入查询循环。这是全局性的改变，不仅限于 monitor-kind 任务。

---

## 十、npm v2.1.101 逆向发现

### 10.1 Feature Flag 状态

`feature('MONITOR_TOOL')` 在 npm 公开构建中编译为 `false`。证据：

| 位置 | 编译结果 | 说明 |
|------|----------|------|
| MonitorMcpTask 模块变量 | `HxY = null`（bundle line 548745） | 整个模块被置空 |
| `enqueueShellNotification` monitor 分支 | `if (!1)`（bundle line 355200） | 死代码，case 体被清空 |
| 通知优先级 | `priority: "later"`（bundle line 355229） | 未提升为 'next' |
| `killMonitorMcp` | `HxY?.killMonitorMcp ?? null`（bundle line 548778） | 由于 HxY=null，结果为 null |
| BashTool sleep 阻断 | 不存在 | 整段被 DCE |
| BashTool prompt Monitor 引导 | 不存在 | 整段被 DCE |

### 10.2 存活的代码

以下代码因不受 feature flag 保护而存活于 npm 构建中：

- `TaskType` 枚举含 `'monitor_mcp'`（bundle line 573880）
- `pillLabel` 对 monitor_mcp 和 kind:'monitor' 的处理（bundle line 436601-436633）
- `BackgroundTasksDialog` 中 `case 'monitor_mcp':` 渲染分支（bundle line 545901）
- `BashTaskKind` 类型含 `'monitor'`
- Stall watchdog 的 `if (_ === "monitor") return () => {};`（bundle line 355133）
- monitor_mcp 的 pill label text `"1 monitor"` / `"N monitors"`

### 10.3 结论

**npm 包不包含 MonitorTool 的任何实际实现。** 所有工具定义（input schema、prompt、call()）、任务管理（spawn、事件流、kill）、UI 组件（权限对话框、详情面板）均被 DCE 移除。实现只能通过推断重建。

---

## 十一、实现路线图

### 11.1 需要实现的组件（按依赖排序）

| 序号 | 组件 | 文件路径 | 依赖 |
|------|------|----------|------|
| 1 | MonitorMcpTaskState 类型 | `src/tasks/MonitorMcpTask/MonitorMcpTask.ts` | TaskStateBase |
| 2 | enqueueStreamEvent 机制 | 新函数或扩展 `enqueuePendingNotification` | 消息队列系统 |
| 3 | MonitorMcpTask（spawn/kill/事件流） | `src/tasks/MonitorMcpTask/MonitorMcpTask.ts` | #1, #2 |
| 4 | MonitorTool（工具定义） | `src/tools/MonitorTool/MonitorTool.ts` | #3 |
| 5 | MonitorPermissionRequest | `src/components/permissions/MonitorPermissionRequest/` | #4 |
| 6 | MonitorMcpDetailDialog | `src/components/tasks/MonitorMcpDetailDialog.ts` | #3 |
| 7 | 启用 feature flag | `build.ts` define 或 env var 覆盖 | #1-#6 |

### 11.2 实现策略

**方案 A：完整双轨实现**
- 实现 MonitorMcpTask（独立任务类型）+ MonitorTool
- 复用 LocalShellTask 的进程管理，但添加逐行 stdout 流式推送
- 实现所有 UI 组件

**方案 B：轻量变体轨实现**
- 仅使用 LocalShellTask `kind: 'monitor'`，不实现 MonitorMcpTask
- MonitorTool 内部直接通过 BashTool 的 background task 机制 + `kind: 'monitor'` 启动
- 跳过 MonitorMcpDetailDialog，复用 Shell detail dialog（已支持 monitor kind 标题）
- 缺点：不符合官方架构，类型系统不匹配

**推荐方案 A**，因为集成骨架已完整搭建，且双轨架构可能有功能上的考量（如 MCP 事件源、更精细的生命周期管理）。

### 11.3 核心实现细节推断

**enqueueStreamEvent 的实现推测**：

```typescript
function enqueueStreamEvent(taskId: string, line: string, agentId?: AgentId) {
  // 构造不含 <status> 标签的 task-notification XML
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(taskId)}</${OUTPUT_FILE_TAG}>
<${SUMMARY_TAG}>${escapeXml(line)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`;

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',  // 高优先级，无需 Sleep 即可 drain
    agentId,
  });
}
```

关键：**没有 `<status>` 标签**。这使得：
- `cli/print.ts` 跳过 SDK 事件发射
- `collapseBackgroundBashNotifications` 不匹配
- 查询循环将其视为进度 ping 而非终态信号

**stdout 逐行读取循环推测**：

```typescript
// MonitorMcpTask spawn 内部
const process = spawn(command, { shell: true });
const rl = readline.createInterface({ input: process.stdout });

rl.on('line', (line) => {
  // 写入 output file（供 TaskOutput/Read 读取）
  appendToOutputFile(taskId, line);
  // 流式推送到对话
  enqueueStreamEvent(taskId, line, agentId);
});

process.on('exit', (code) => {
  // 终态通知（有 <status> 标签）
  enqueuePendingNotification({ ... status: code === 0 ? 'completed' : 'failed' ... });
});
```

### 11.4 验证清单

- [ ] MonitorTool 出现在 `getAllBaseTools()` 返回的工具列表中
- [ ] 模型能够调用 Monitor tool（检查 API schema 生成）
- [ ] Monitor 启动后在状态栏显示 "1 monitor" pill
- [ ] 每行 stdout 作为 task-notification 注入对话
- [ ] Claude 能在下一 turn 响应 monitor 事件
- [ ] `/agents` 或 BackgroundTasksDialog 显示 monitor 任务
- [ ] Kill monitor 正常终止进程
- [ ] Agent 退出时清理 orphaned monitors
- [ ] sleep ≥ 2s 被阻断并引导使用 Monitor
- [ ] BashTool prompt 中包含 Monitor 引导文本

---

## 十二、配置项速查

| 配置 | 类型 | 说明 |
|------|------|------|
| `feature('MONITOR_TOOL')` | 编译时 flag | 总开关，控制所有 Monitor 相关代码 |
| Bash allow/deny 规则 | settings.json | 同时适用于 Monitor |
| `CLAUDE_CODE_DISABLE_CRON` | 环境变量 | 禁用定时任务（影响 Monitor + /loop 集成） |
| `isBackgroundTasksDisabled` | 运行时 | 如果禁用后台任务，sleep 阻断也不生效 |

---

## 十三、数据流总览

```
用户: "帮我监控 CI 状态"
    │
    ▼
Claude 生成监控脚本
    │
    ▼
MonitorTool.call(command, description)
    │
    ├─ checkPermissions() → MonitorPermissionRequest UI
    │   (使用 Bash 权限规则)
    │
    ├─ 创建 MonitorMcpTask
    │   ├─ type: 'monitor_mcp', id: 'm-xxxxxxxx'
    │   ├─ registerTask() → AppState.tasks
    │   └─ spawn 后台进程
    │
    ├─ 同时可能创建 LocalShellTask kind:'monitor'
    │   ├─ type: 'local_bash', kind: 'monitor'
    │   ├─ stall watchdog 跳过
    │   └─ 通知摘要使用 Monitor 前缀
    │
    └─ stdout 逐行读取循环
          │
          ├─ 每行 stdout
          │   ├─ 写入 output file
          │   └─ enqueueStreamEvent()
          │       ├─ XML: <task_notification> 无 <status>
          │       ├─ priority: 'next'
          │       ├─ cli/print.ts: 跳过 SDK emit
          │       ├─ collapse: 不折叠
          │       └─ query loop: 下一空闲 turn 注入
          │           └─ Claude 响应事件
          │
          └─ 进程退出
              ├─ enqueuePendingNotification()
              │   ├─ XML: <task_notification> 有 <status>
              │   └─ 摘要: "Monitor '...' stream ended/failed/stopped"
              └─ 更新 task status → completed/failed/killed

清理路径:
  ├─ 用户取消 → BackgroundTasksDialog → killMonitorMcp()
  ├─ Agent 退出 → killMonitorMcpTasksForAgent()
  └─ 会话结束 → 进程随 session 终止

UI 表面:
  ├─ 状态栏 pill: "1 monitor" / "N monitors"
  ├─ BackgroundTasksDialog: "Monitors" 分区
  └─ MonitorMcpDetailDialog: 详情 + Kill
```
