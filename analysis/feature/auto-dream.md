# Auto Dream — 后台记忆整合机制

> **一句话定义**：autoDream 是一个在每轮对话结束后悄悄触发的 forked subagent，负责把 Claude 的碎片化 memory 文件自动蒸馏、整合、去重，保持 MEMORY.md 的精简与准确。

---

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/services/autoDream/autoDream.ts` | 触发判断、fork 执行、进度追踪 |
| `src/services/autoDream/config.ts` | 配置项（minHours、minSessions、feature flag） |
| `src/services/autoDream/consolidationLock.ts` | 锁文件读写（`lastConsolidatedAt` 时间戳） |
| `src/services/autoDream/consolidationPrompt.ts` | 4-phase 整合 prompt |
| `src/tasks/DreamTask/DreamTask.ts` | Task 状态管理（UI 注册、进度更新、kill） |
| `src/query/stopHooks.ts` | 触发点：每轮对话结束后调用 `executeAutoDream()` |
| `src/utils/backgroundHousekeeping.ts` | 启动时调用 `initAutoDream()` |
| `src/skills/bundled/dream.ts` | 手动 `/dream` skill（外部构建抛异常，内部专用） |

---

## 触发链路

```
[启动]
backgroundHousekeeping.ts:37
  └─ initAutoDream()

[每轮结束]
stopHooks.ts:154-156
  └─ executeAutoDream(stopHookContext, appendSystemMessage)
        └─ isGateOpen() ────────────── 失败 → 静默退出
        └─ 时间门（≥24h 未整合）────── 失败 → 静默退出
        └─ 扫描节流（10 min 间隔）──── 失败 → 静默退出
        └─ Session 门（≥5 个 session） 失败 → 静默退出
        └─ 锁门（.consolidate-lock）── 失败 → 静默退出
              └─ runForkedAgent(consolidationPrompt, ...)
```

### 五道门详解

| 门 | 条件 | 说明 |
|----|------|------|
| Gate open | KAIROS 未激活 + 非 remote 模式 + auto-memory 已开启 + `autoDreamEnabled=true` | 全局开关 |
| 时间门 | `now - lastConsolidatedAt >= minHours`（默认 24h） | 避免频繁整合 |
| 扫描节流 | 距上次扫描 >= `SESSION_SCAN_INTERVAL_MS`（10 min） | 每轮调用但不每轮扫描磁盘 |
| Session 门 | 自上次整合以来的 session 数（不含当前）>= `minSessions`（默认 5） | 保证有足够新内容 |
| 锁门 | `tryAcquireConsolidationLock()` 成功 | 防多进程竞争；过期阈值 1 小时 |

---

## Fork Agent 执行

```ts
// autoDream.ts:224-233
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: prompt })],
  querySource: 'auto_dream',
  forkLabel: 'auto_dream',
  skipTranscript: true,
  canUseTool: createAutoMemCanUseTool(memoryRoot),
  overrides: { abortController },
  onMessage: makeDreamProgressWatcher(taskId, setAppState),
})
```

**工具限制**（`createAutoMemCanUseTool`）：
- Bash：只读命令（`ls`、`find`、`grep`、`cat`、`stat`...）
- Edit / Write：仅限 auto-memory 目录
- 禁止所有网络、外部系统工具

---

## 整合 Prompt（4 阶段）

| 阶段 | 操作 | 关键约束 |
|------|------|----------|
| Phase 1 — Orient | `ls` memory dir、读 MEMORY.md、粗扫 topic 文件 | 只读 |
| Phase 2 — Gather | 检查 daily logs、grep 近期 transcript | grep 要窄（加关键词） |
| Phase 3 — Consolidate | 写/更新 memory 文件、转换相对日期为绝对日期、删除矛盾事实 | 不推断，只记录有证据的内容 |
| Phase 4 — Prune & Index | 保持 MEMORY.md < 200 行 / 25KB，删除失效指针 | 精简优先 |

---

## 锁文件机制

文件路径：`<autoMemPath>/.consolidate-lock`  
文件内容：持有者 PID  
文件 mtime：`lastConsolidatedAt`（最后一次整合的时间戳）

```
tryAcquireConsolidationLock()
  ├─ 写入 PID
  ├─ 验证无竞争（读回 PID 一致）
  └─ 返回 priorMtime（供 rollback 用）

rollbackConsolidationLock(priorMtime)
  └─ 整合失败或用户 kill 时，回退 mtime
     → 时间门下次仍会触发（扫描节流提供退避）

recordConsolidation()
  └─ 手动 /dream skill 完成时调用（最终确认时间戳）
```

---

## Task 状态与 UI

### DreamTaskState

```ts
type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: 'starting' | 'updating'  // 第一次 Edit/Write 后切换到 'updating'
  sessionsReviewing: number
  filesTouched: string[]           // 被 Edit/Write 的文件（不完整反射）
  turns: DreamTurn[]               // 最近 30 条 assistant turn
  abortController?: AbortController
  priorMtime: number               // kill 时回滚锁用
}
```

### UI 入口

| 位置 | 表现 |
|------|------|
| 底部状态栏 pill | 显示 `dreaming` 文字（`pillLabel.ts:61-62`） |
| BackgroundTasksDialog | dream task 列表项，`↑↓` 选择，`x` kill，`Enter` 详情 |
| DreamDetailDialog | 标题"Memory consolidation"，显示耗时 + session 数 + 触碰文件数 + 最近 6 条文字 turn |
| MemoryFileSelector | "Auto-dream: on/off" 切换行，显示状态（running / never / last ran Xm ago） |

### Kill 行为

```
DreamTask.kill()
  ├─ abortController.abort()
  └─ rollbackConsolidationLock(priorMtime)
```

---

## 配置

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `autoDreamEnabled` | `boolean?`（settings.json） | 覆盖 GrowthBook 默认值 |
| GrowthBook flag | `tengu_onyx_plover` | 远端实验门控（决定是否向用户开放） |
| `minHours` | number（config.ts） | 两次整合的最小间隔，默认 24h |
| `minSessions` | number（config.ts） | 触发整合所需最少 session 数，默认 5 |

**ConfigTool key**：`autoDreamEnabled`（source: 'settings', type: 'boolean'）

---

## Analytics 事件

| 事件名 | 触发时机 |
|--------|----------|
| `tengu_auto_dream_fired` | fork 发出时 |
| `tengu_auto_dream_completed` | agent 正常完成 |
| `tengu_auto_dream_failed` | agent 报错 |
| `tengu_auto_dream_toggled` | 用户在 UI 切换开关 |

---

## KAIROS 模式

### 什么是 KAIROS

KAIROS 是 Claude Code 的**持久助手守护进程模式**（persistent assistant daemon mode）——让 Claude 作为一个始终在线的个人助手运行，而非单次会话工具。内部代号来自希腊语"恰当时机"（καιρός）。

它是 Anthropic 内部功能，通过**两层门控**保护：
1. **构建时**：`feature('KAIROS')` — 编译期 dead code elimination，外部构建中所有 KAIROS 代码块被裁掉
2. **运行时**：GrowthBook 远端实验 gate `tengu_kairos` — 决定向哪些用户开放

### 激活条件（三条路径）

| 路径 | 条件 | 结果 |
|------|------|------|
| 配置文件 | `.claude/settings.json` 含 `assistant: true` + `tengu_kairos` GB gate 通过 + 目录已信任 | 完整守护模式 |
| CLI 参数 | `--assistant` flag（跳过 GB gate，预授权用） | 完整守护模式 |
| 查看器 | `claude assistant [sessionId]` | 只读查看器模式（`kairosActive=true`, `kairosEnabled=false`） |

代码路径（`main.tsx:1033-1088`）：
```ts
kairosEnabled = assistantModule.isAssistantForced()
             || (await kairosGate.isKairosEnabled())
if (kairosEnabled) {
  opts.brief = true                          // 强制开启 Brief 模式
  setKairosActive(true)                      // 进程全局标志
  assistantModule.initializeAssistantTeam()  // 初始化 assistant team
}
```

### 两个运行时状态字段

| 字段 | 位置 | 用途 |
|------|------|------|
| `kairosActive` | `bootstrap/state.ts` | 进程全局布尔，同步设置，供工具层代码（BriefTool、BashTool、memdir、StatusLine）判断 |
| `kairosEnabled` | `AppStateStore.ts` | React store 字段，传入 REPL initialState，供 REPL/AgentTool/slash command 异步调度判断 |

### 激活 KAIROS 后的行为变化

**输出层：**
- 强制开启 `--brief`，BriefTool（`SendUserMessage`）成为主输出通道
- 追加自定义 system prompt addendum（来自 `assistant/index.ts`）
- 隐藏 StatusLine（原 StatusLine 反映的是 REPL 进程上下文，与 assistant 无关）

**记忆层：**
- Memory 系统从"写回 `MEMORY.md`"切换为**追加写入每日日志**（`logs/YYYY/MM/YYYY-MM-DD.md`）
- 夜间由 `/dream` cron skill 将日志蒸馏回 `MEMORY.md` 和 topic 文件
- `memdir.ts` 调度逻辑：`feature('KAIROS') && autoEnabled && getKairosActive()` → `buildAssistantDailyLogPrompt()`

**并发层：**
- AgentTool 的所有子 agent 强制异步（`assistantForceAsync = true`）
- Slash command 子 agent fire-and-forget，完成后以 `isMeta` prompt 重新入队，避免 N 个计划任务串行阻塞
- BashTool / PowerShellTool：主线程阻塞命令超过 `ASSISTANT_BLOCKING_BUDGET_MS` 后自动后台化

**会话层：**
- Bridge 注册 `workerType: 'claude_code_assistant'`（Web UI 用于过滤会话列表）
- `remote-control` 子命令启用 `--session-id` / `--continue` 恢复（读取 `bridgePointer.json`）
- 单会话模式下 shutdown 时跳过 archive+deregister，支持 `remote-control --continue` 续接
- Fast mode SDK 限制豁免（`kairosActive` 绕过"不在 Agent SDK 中可用"检查）

**通知层（`KAIROS || KAIROS_PUSH_NOTIFICATION` 门控）：**
- `taskCompleteNotifEnabled`：Claude 完成任务空闲后推送移动端通知
- `inputNeededNotifEnabled`：等待权限确认时推送移动端通知

### 三个常驻 cron 任务（`assistant/install.ts` 安装）

KAIROS 激活时，`assistant/install.ts`（Anthropic 内部，未公开）向 `scheduled_tasks.json` 写入三个 `permanent: true` 任务：

| 任务名 | 描述 |
|--------|------|
| `catch-up` | 启动时追赶错过的计划任务（重启续接） |
| `morning-checkin` | 每天早晨主动问候 + 日程回顾 |
| `dream` | 凌晨 1–5 点执行记忆整合（替代 autoDream） |

`permanent: true` 的特殊语义（`cronTasks.ts:55`）：这些任务由安装器的 `writeIfMissing()` 写入，重新安装不会覆盖，用户可手动删除后永久生效。CronCreateTool 无法创建此类任务。

### 相关 GrowthBook Gates

| Gate | 默认值 | 用途 |
|------|--------|------|
| `tengu_kairos` | — | 主 KAIROS 准入门（`gate.ts:isKairosEnabled()`，磁盘缓存） |
| `tengu_kairos_brief` | false | 向非 assistant 用户开放 BriefTool |
| `tengu_kairos_cron` | **true** | cron 调度器总开关（`AGENT_TRIGGERS` 构建门，与 KAIROS 独立） |
| `tengu_kairos_cron_durable` | true | 磁盘持久化 cron 开关 |
| `tengu_kairos_cron_config` | 内置默认值 | 运营调参 JSON（jitter/timing） |

> **注意**：`isKairosCronEnabled()` 的构建门是 `feature('AGENT_TRIGGERS')`，不是 `feature('KAIROS')`。cron 系统对 KAIROS 零依赖，可独立发布。KAIROS 对 cron 的唯一影响是：`kairosEnabled` 绕过 `isLoading` 门，使调度器在 proactive tick→Sleep→tick 循环期间保持运转。

---

## autoDream vs. KAIROS Dream（两条路径）

| 维度 | autoDream（外部用户） | KAIROS `/dream` skill（内部） |
|------|-----------------------|-------------------------------|
| 触发方式 | `stopHooks` 每轮轮询 | cron 任务，每天凌晨 1–5 点 |
| 注册条件 | `autoDreamEnabled` + GB flag | `feature('KAIROS')` / `feature('KAIROS_DREAM')` |
| 外部构建 | 完整可用 | `dream.ts` stub 直接抛异常 |
| 互斥 | `isGateOpen()` 检测到 KAIROS active 时，autoDream **不触发** | — |

```ts
// autoDream.ts:96
if (getKairosActive()) return false  // KAIROS 模式用磁盘 skill，不走 autoDream
```

---

## 与 Auto Memory 的关系

autoDream 是 auto memory 系统的**整合层**：
- Auto memory 的 `extractMemories` 负责**提取**：每轮对话后把值得记住的内容写入 memory 文件
- autoDream 负责**整合**：定期把碎片化的 memory 文件蒸馏为结构化、去重的知识库
- 两者均通过 `isAutoMemoryEnabled()` 作为前置门

```
对话 → extractMemories → 碎片 memory 文件
                              ↓（积累 5 个 session / 24h）
                         autoDream consolidation
                              ↓
                    精简的 MEMORY.md + topic 文件
```

---

## 关键设计取舍

1. **skipTranscript: true** — dream 的推理过程不写入对话历史，不干扰主线程上下文
2. **锁文件 mtime 复用** — 同一个文件同时充当互斥锁和时间戳，节省一次 I/O
3. **rollback on kill** — 用户中止 dream 后，时间门立即重新开放（不等 24h），配合扫描节流做退避
4. **工具白名单** — 只开放读操作和 auto-memory 写权限，dream agent 无法操作代码或外部系统
5. **filesTouched 不完整** — 只反射 Edit/Write 调用，非 Bash 输出的变更无法追踪（已知局限）
