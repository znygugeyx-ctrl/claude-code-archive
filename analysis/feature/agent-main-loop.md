# Claude Code Agent 主循环逻辑分析

> 核心源码路径：`src/query.ts`、`src/services/api/claude.ts`、`src/services/tools/`、`src/screens/REPL.tsx`

---

## 一、总体架构

Claude Code 的 Agent 主循环是一个双层结构：

- **外层循环**（REPL）：等待用户输入 → 处理 → 调用内层循环 → 渲染结果 → 回到等待
- **内层循环**（Query Loop）：发送 API 请求 → 流式处理响应 → 执行工具 → 判断是否继续 → 下一轮

```
用户输入 → REPL.handlePromptSubmit()
              ↓
           processUserInput()  (斜杠命令/图片/skill 处理)
              ↓
           onQuery() → onQueryImpl()
              ↓
           query() → queryLoop()   ← 内层 while(true) 循环
              ↓                       每轮 = 1 次 API 调用 + 工具执行
           返回终止原因 → REPL 回到输入状态
```

---

## 二、外层循环（REPL）

### 2.1 用户输入处理

**文件**：`src/utils/handlePromptSubmit.ts`（line 120+）

```typescript
handlePromptSubmit()
  → processUserInput()     // 处理斜杠命令、图片、skill
  → if (shouldQuery) onQuery()
```

**文件**：`src/screens/REPL.tsx`（line 2855+）

```typescript
onQuery()
  → QueryGuard 并发控制（同时只允许一个 query；并发提交入队）
  → onQueryImpl()
```

### 2.2 查询执行

**文件**：`src/screens/REPL.tsx`（line 2661+）

`onQueryImpl()` 的核心流程：

1. 构建系统提示词各部分（`getSystemPrompt`、`getUserContext`、`getSystemContext`）
2. 调用 `query()` 获取异步生成器
3. 遍历生成器：`for await (const event of query({...}))`
4. 每个事件分发到 `onQueryEvent()` → `handleMessageFromStream()` 更新 React 状态
5. 完成后 `resetLoadingState()`，REPL 回到输入模式

### 2.3 SDK/Headless 路径

**文件**：`src/QueryEngine.ts`（line 209+）

`QueryEngine.submitMessage()` 执行相同逻辑，但 yield `SDKMessage` 事件。独立函数 `ask()`（line 1186）创建 QueryEngine 并调用 `submitMessage()`。

---

## 三、内层循环（Query Loop）—— 核心

### 3.1 入口

**文件**：`src/query.ts`（line 219）

```typescript
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
>
```

薄包装层，委托给 `queryLoop()` 并在完成时处理命令生命周期通知。

### 3.2 循环状态

**文件**：`src/query.ts`（line 241+）

`queryLoop()` 是 `while (true)` 异步生成器，状态通过可变 `State` 对象携带：

```typescript
type State = {
  messages: Message[]                           // 对话历史
  toolUseContext: ToolUseContext                 // 工具执行上下文
  autoCompactTracking: AutoCompactTrackingState // 自动压缩追踪
  maxOutputTokensRecoveryCount: number          // 输出 token 恢复计数
  hasAttemptedReactiveCompact: boolean          // 是否已尝试被动压缩
  maxOutputTokensOverride: number | undefined   // 输出 token 覆盖值
  pendingToolUseSummary: Promise<...>           // 待处理的工具摘要
  stopHookActive: boolean | undefined           // stop hook 是否激活
  turnCount: number                             // 当前轮次
  transition: Continue | undefined              // 上一轮继续的原因
}
```

每轮迭代代表一次「API 调用 + 工具执行」。循环通过 `state = next; continue` 继续，或通过 `return { reason: '...' }` 终止。

### 3.3 单轮迭代的完整流程

```
while (true) {
  ┌─────────────────────────────────────────────────┐
  │ 阶段 1：消息预处理                                │
  │  getMessagesAfterCompactBoundary()              │
  │  applyToolResultBudget()                        │
  │  snipCompactIfNeeded()                          │
  │  microcompact()                                 │
  │  applyCollapsesIfNeeded()                       │
  │  asSystemPrompt(appendSystemContext(...))        │
  │  autoCompactIfNeeded()                          │
  └─────────────────────────────────────────────────┘
           ↓
  ┌─────────────────────────────────────────────────┐
  │ 阶段 2：API 调用（流式）                          │
  │  callModel() → queryModel() → withRetry()       │
  │  流式接收 SSE 事件                                │
  │  并行启动 StreamingToolExecutor                   │
  └─────────────────────────────────────────────────┘
           ↓
  ┌─────────────────────────────────────────────────┐
  │ 阶段 3：响应处理                                  │
  │  解析 stop_reason                                │
  │  处理错误（prompt_too_long / max_output_tokens）  │
  │  收集 tool_use 块                                │
  └─────────────────────────────────────────────────┘
           ↓
  ┌─────────────────────────────────────────────────┐
  │ 阶段 4：工具执行                                  │
  │  StreamingToolExecutor.getRemainingResults()     │
  │  或 runTools()                                   │
  │  收集 tool_result                                │
  └─────────────────────────────────────────────────┘
           ↓
  ┌─────────────────────────────────────────────────┐
  │ 阶段 5：后处理与续行判定                           │
  │  附件消息、内存预取、skill 发现                     │
  │  stop hooks 检查                                 │
  │  maxTurns 检查                                   │
  │  构建 next state → continue / return             │
  └─────────────────────────────────────────────────┘
}
```

---

## 四、阶段 1：消息预处理（每轮迭代开始）

**文件**：`src/query.ts`（line 365-549）

### 4.1 压缩边界裁剪

```typescript
getMessagesAfterCompactBoundary(messages)
```

从最后一个 compact boundary marker 处切片，丢弃之前的原始消息（已被摘要替代）。

### 4.2 工具结果预算

```typescript
applyToolResultBudget()
```

对每条消息的工具结果强制执行 token 预算，超预算的旧结果被替换为 `[Old tool result content cleared]`。

### 4.3 Snip 压缩

```typescript
snipCompactIfNeeded()  // line 401-410
```

移除旧消息（SnipTool 触发的历史裁剪）。

### 4.4 Microcompact

```typescript
deps.microcompact()  // line 414-419
```

细粒度压缩：基于时间阈值清理旧工具结果（详见压缩机制文档）。

### 4.5 Context Collapse

```typescript
applyCollapsesIfNeeded()  // line 440-447
```

投影折叠后的上下文视图（Anthropic 内部特性）。

### 4.6 系统提示词组装

```typescript
asSystemPrompt(appendSystemContext(systemPrompt, systemContext))  // line 449-451
```

将系统上下文追加到系统提示词。

### 4.7 自动压缩

```typescript
deps.autocompact()  // line 454-467
```

若 token 数超过 `autoCompactThreshold`，触发全量压缩。压缩成功后替换 `messagesForQuery`，重置追踪状态。

---

## 五、阶段 2：API 调用与流式处理

### 5.1 请求组装

**文件**：`src/services/api/claude.ts`（line 1017-1729）

`queryModel()` 中的请求构建：

```
1. toolToAPISchema()           为每个工具生成 API schema（含 deferred-loading）
2. normalizeMessagesForAPI()   规范化消息格式
3. ensureToolResultPairing()   修复 tool_use/tool_result 配对
4. 系统提示词最终化             归因头 + CLI 前缀 + advisor 指令
5. buildSystemPromptBlocks()   带缓存断点的系统提示块
6. prependUserContext()        用 <system-reminder> 包裹用户上下文
```

`paramsFromContext()` 闭包（line 1538-1729）构造最终 API 参数：

```typescript
{
  model,
  messages,          // 带缓存断点
  system,            // 系统提示块
  tools,             // 工具 schema
  betas,             // beta 标志
  thinking,          // thinking 配置
  temperature,
  effort,            // 推理努力
  task_budget,       // token 预算
  speed,             // fast 模式
  context_management // 上下文管理
}
```

### 5.2 流式 SSE 事件处理

**文件**：`src/services/api/claude.ts`（line 1940-2215）

```typescript
for await (const part of stream) {
  switch (part.type) {
    case 'message_start':        // 捕获 partialMessage，设置 TTFB
    case 'content_block_start':  // 初始化内容块
    case 'content_block_delta':  // 追加内容
    case 'content_block_stop':   // 创建 AssistantMessage 并 yield
    case 'message_delta':        // 更新 usage，捕获 stop_reason
  }
}
```

各内容块类型的初始化与增量更新：

| 块类型 | 初始化 | Delta 追加 |
|--------|--------|-----------|
| `tool_use` | `{ input: '' }` | `input += partial_json` |
| `text` | `{ text: '' }` | `text += delta.text` |
| `thinking` | `{ thinking: '', signature: '' }` | `thinking += delta.thinking`, `signature = delta.signature` |
| `server_tool_use` | advisor 工具处理 | — |

### 5.3 流式工具启动

**文件**：`src/query.ts`（line 837-862）

在流式接收过程中，已完成的 `tool_use` 块立即提交给 StreamingToolExecutor：

```typescript
// 流式期间
streamingToolExecutor.addTool(toolBlock, message)

// 流式期间获取已完成的结果
for await (const result of streamingToolExecutor.getCompletedResults()) {
  yield result.message
}
```

### 5.4 Fallback 机制

**文件**：`src/query.ts`（line 650-953）

```typescript
while (attemptWithFallback) {
  attemptWithFallback = false
  try {
    for await (const message of deps.callModel({...})) { ... }
  } catch (innerError) {
    if (innerError instanceof FallbackTriggeredError && fallbackModel) {
      currentModel = fallbackModel
      attemptWithFallback = true
      // 清除已累积状态，重试
    }
  }
}
```

当 529 错误超过 `MAX_529_RETRIES = 3` 次时，触发 FallbackTriggeredError，切换到备用模型重试。

---

## 六、阶段 3：响应处理与错误恢复

### 6.1 错误重试

**文件**：`src/services/api/withRetry.ts`（line 170+）

```typescript
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T>
```

| 参数 | 值 |
|------|-----|
| 最大重试次数 | `DEFAULT_MAX_RETRIES = 10`（`CLAUDE_CODE_MAX_RETRIES` 覆盖） |
| 基础延迟 | `BASE_DELAY_MS = 500` |
| 最大 529 重试 | `MAX_529_RETRIES = 3`（超过后触发 fallback） |

各错误类型处理：

| 错误 | 处理方式 |
|------|----------|
| **429/529 + fast 模式** | 短 retry-after（< 阈值）快速重试；长 retry-after 降速到标准模式 |
| **529 (过载)** | 计数，超过 3 次触发 `FallbackTriggeredError` |
| **401** | 刷新 OAuth token，重建客户端 |
| **403 "token revoked"** | 同 401 |
| **ECONNRESET/EPIPE** | 禁用 keep-alive，重建客户端 |
| **非前台 529** | 立即放弃（避免后台查询的重试放大） |
| **持久重试**（`CLAUDE_CODE_UNATTENDED_RETRY`） | 429/529 无限重试，最大退避 5 分钟 |

### 6.2 prompt_too_long 处理

**文件**：`src/query.ts`（line 1090-1182）

```
prompt_too_long (413)
    ↓
applyCollapsesIfNeeded()    // context collapse 排出
    ↓ 仍然失败
reactiveCompact()           // 被动压缩（REACTIVE_COMPACT 特性标志）
    ↓ 仍然失败
return { reason: 'prompt_too_long' }   // 终止循环
```

### 6.3 max_output_tokens 恢复

**文件**：`src/query.ts`（line 1188-1256）

三级恢复策略：

```
max_output_tokens 触发
    ↓
第 1 步：从默认 8k 升级到 64k（max_output_tokens_escalate）
    ↓ 再次触发
第 2 步：注入恢复消息，最多 3 次（MAX_OUTPUT_TOKENS_RECOVERY_LIMIT）
    恢复消息: "Output token limit hit. Resume directly — no apology, no recap..."
    ↓ 超过 3 次
第 3 步：表面化错误，正常终止
```

---

## 七、阶段 4：工具执行

### 7.1 两种执行模式

**A. StreamingToolExecutor**

**文件**：`src/services/tools/StreamingToolExecutor.ts`

- 维护 `TrackedTool` 队列，状态：`queued → executing → completed → yielded`
- 并发安全工具并行执行；非并发工具独占执行
- `addTool()` 在流式期间调用；`getCompletedResults()` 在流式期间收割；`getRemainingResults()` 在流式后收割

**B. runTools()**

**文件**：`src/services/tools/toolOrchestration.ts`（line 19+）

```typescript
export async function* runTools(
  toolUseBlocks, assistantMessages, canUseTool, toolUseContext
)
```

- 按 `isConcurrencySafe` 分区为连续批次
- 并发批次 → `runToolsConcurrently`（最大并发 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`，默认 10）
- 串行批次 → `runToolsSerially`

### 7.2 工具结果回注

**文件**：`src/query.ts`（line 1360-1408）

```typescript
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message
    toolResults.push(...)
  }
  if (update.newContext) {
    updatedToolUseContext = { ...update.newContext, queryTracking }
  }
}
```

### 7.3 工具摘要（异步）

**文件**：`src/query.ts`（line 1412-1481）

工具批次完成后，fire-and-forget 调用 `generateToolUseSummary()`（使用 Haiku 模型）：

```typescript
pendingToolUseSummary = generateToolUseSummary(...)
// 传递到下一轮迭代，在模型流式期间 resolve（零等待）
```

---

## 八、阶段 5：后处理与续行判定

### 8.1 后处理

**文件**：`src/query.ts`（line 1580-1628）

```
附件消息获取        文件变更通知、排队命令
内存预取消费        相关内存文件（startRelevantMemoryPrefetch）
Skill 发现预取消费   skill 内容
```

### 8.2 Stop Hooks

**文件**：`src/query.ts`（line 1267-1306）、`src/query/stopHooks.ts`（line 65+）

当循环正常终止（无 tool_use，end_turn）时，先检查 stop hooks：

```typescript
const stopHookResult = yield* handleStopHooks(...)

if (stopHookResult.preventContinuation) {
  return { reason: 'stop_hook_prevented' }
}

if (stopHookResult.blockingErrors.length > 0) {
  // stop hook 返回了阻塞错误，将错误注入消息继续循环
  state = {
    messages: [..., ...stopHookResult.blockingErrors],
    stopHookActive: true,
    ...
  }
  continue  // 重新进入循环
}
```

### 8.3 续行判定

**文件**：`src/query.ts`（line 1715-1728）

当存在 tool_use 块时，构建下一轮状态：

```typescript
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  transition: { reason: 'next_turn' },
}
state = next
// while(true) continues
```

---

## 九、循环终止条件

### 9.1 终止原因一览

| 原因 | 触发条件 |
|------|----------|
| `'completed'` | 正常结束：`end_turn`，无 tool_use 块 |
| `'max_turns'` | 超过 `maxTurns` 限制 |
| `'aborted_streaming'` | 用户在流式期间中断 |
| `'aborted_tools'` | 用户在工具执行期间中断 |
| `'blocking_limit'` | token 数达到阻断上限，自动压缩被禁用 |
| `'prompt_too_long'` | prompt 过长，被动压缩失败 |
| `'model_error'` | 不可恢复的 API 错误 |
| `'image_error'` | 图片大小/缩放错误 |
| `'stop_hook_prevented'` | Stop hook 阻止继续 |
| `'hook_stopped'` | 工具 hook 指示停止 |

### 9.2 继续原因一览

| 原因 | 触发条件 |
|------|----------|
| `'next_turn'` | 存在 tool_use 块，结果已回注 |
| `'max_output_tokens_escalate'` | 输出 token 上限，从 8k 升级到 64k |
| `'max_output_tokens_recovery'` | 输出 token 上限，注入恢复消息（最多 3 次） |
| `'reactive_compact_retry'` | prompt_too_long，被动压缩成功 |
| `'collapse_drain_retry'` | context collapse 排出了暂存折叠 |
| `'stop_hook_blocking'` | stop hook 返回了阻塞错误，需继续处理 |
| `'token_budget_continuation'` | token 预算未耗尽（TOKEN_BUDGET 特性标志） |

---

## 十、Hooks 集成

### 10.1 查询生命周期中的 Hook 事件

| Hook | 文件 | 触发时机 |
|------|------|----------|
| **UserPromptSubmit** | `utils/hooks.ts:3826` | 查询前，`processUserInput` 中 |
| **PreToolUse** | `services/tools/toolHooks.ts` | 每个工具执行前 |
| **PostToolUse** | `services/tools/toolHooks.ts` | 每个工具执行后 |
| **PostSampling** | `utils/hooks/postSamplingHooks.ts:45` | 模型响应后，fire-and-forget |
| **Stop** | `query/stopHooks.ts:65` | 循环将要终止时（无 tool_use） |
| **SessionStart** | `utils/hooks.ts:3867` | 会话初始化/恢复/清除时 |
| **Notification** | `utils/hooks.ts:3570` | 通知事件 |

### 10.2 PostSampling Hook

**文件**：`src/query.ts`（line 1001）

模型响应完成后立即 fire-and-forget 触发，不阻塞主循环。

---

## 十一、特殊流程

### 11.1 Token 预算续行

**文件**：`src/query/tokenBudget.ts`

当 `TOKEN_BUDGET` 特性启用时：

```
checkTokenBudget() → 'continue' 如果 < 90% 预算
    → 注入 nudge 消息，继续循环
    → 检测收益递减（delta < 500 tokens 连续 3+ 轮）
```

### 11.2 内存预取

**文件**：`src/query.ts`（line 1599-1614）

```
startRelevantMemoryPrefetch()   每轮入口触发一次
    → 异步获取相关内存文件
    → 每轮迭代消费（如已 resolve 则零等待）
    → 过滤已在 readFileState 中的重复项
```

### 11.3 上下文/状态管理

| 状态 | 说明 |
|------|------|
| `mutableMessages: Message[]` | 对话历史的权威来源（REPL 的 `setMessages()` 或 QueryEngine 的 `this.mutableMessages`） |
| `messagesRef` | REPL 中的同步 ref，避免闭包过期 |
| `state.messages` | query 循环内的工作副本 |
| `tokenCountWithEstimation()` | 从上一次 API 响应 usage 估算当前上下文大小 |
| `AutoCompactTrackingState` | 追踪轮次计数器和压缩历史 |
| `FileStateCache` | 追踪已读文件状态，用于缓存失效 |
| `NonNullableUsage` | input_tokens、output_tokens、cache_read/creation tokens |

---

## 十二、关键文件索引

| 组件 | 文件 | 关键行 |
|------|------|--------|
| 内层查询循环 | `src/query.ts` | 241-1729 (`queryLoop`) |
| QueryEngine (SDK) | `src/QueryEngine.ts` | 184-1295 |
| API 流式客户端 | `src/services/api/claude.ts` | 1017-2215 (`queryModel`) |
| API 参数构建 | `src/services/api/claude.ts` | 1538-1729 (`paramsFromContext`) |
| 重试/错误处理 | `src/services/api/withRetry.ts` | 170-400 (`withRetry`) |
| 工具编排 | `src/services/tools/toolOrchestration.ts` | 19-82 (`runTools`) |
| 流式工具执行器 | `src/services/tools/StreamingToolExecutor.ts` | 40-70 (class) |
| REPL 外层循环 | `src/screens/REPL.tsx` | 2661-3024 (`onQueryImpl`, `onQuery`) |
| 用户输入处理 | `src/utils/handlePromptSubmit.ts` | 120+ |
| Stop hooks | `src/query/stopHooks.ts` | 65-80 |
| 消息构建 | `src/utils/messages.ts` | 460, 1989 |
| 系统提示词组装 | `src/utils/queryContext.ts` | 44-74 |
| 用户/系统上下文注入 | `src/utils/api.ts` | 437-474 |
| 查询配置 | `src/query/config.ts` | 29-46 |
| Token 预算 | `src/query/tokenBudget.ts` | 45-80 |
| PostSampling hooks | `src/utils/hooks/postSamplingHooks.ts` | 45-60 |

---

## 十三、数据流总览

```
┌─ 外层循环 (REPL / QueryEngine) ──────────────────────────────────────────┐
│                                                                           │
│  用户输入 → handlePromptSubmit() → processUserInput()                     │
│       ↓                                                                   │
│  onQuery() → QueryGuard → onQueryImpl()                                   │
│       ↓                                                                   │
│  ┌─ 内层循环 (queryLoop) ── while(true) ──────────────────────────────┐   │
│  │                                                                     │   │
│  │  ┌─ 消息预处理 ─┐                                                   │   │
│  │  │ compactBoundary → toolResultBudget → snip → microcompact         │   │
│  │  │ → contextCollapse → systemPrompt → autoCompact                   │   │
│  │  └──────────────┘                                                   │   │
│  │       ↓                                                             │   │
│  │  ┌─ API 调用 ──────────────────────┐                                │   │
│  │  │ paramsFromContext() → withRetry()│                                │   │
│  │  │ → stream SSE events             │                                │   │
│  │  │ → 并行 StreamingToolExecutor    │                                │   │
│  │  └──────────────────────────────────┘                                │   │
│  │       ↓                                                             │   │
│  │  ┌─ 错误处理 ──────────────────────┐                                │   │
│  │  │ prompt_too_long → collapse/compact                               │   │
│  │  │ max_output_tokens → escalate/recover                             │   │
│  │  │ 529 → retry/fallback model                                      │   │
│  │  └──────────────────────────────────┘                                │   │
│  │       ↓                                                             │   │
│  │  ┌─ 工具执行 ──────────────────────┐                                │   │
│  │  │ getRemainingResults() / runTools()                                │   │
│  │  │ → tool_result 回注消息历史                                        │   │
│  │  └──────────────────────────────────┘                                │   │
│  │       ↓                                                             │   │
│  │  ┌─ 续行判定 ──────────────────────┐                                │   │
│  │  │ 有 tool_use? → state=next, continue                              │   │
│  │  │ end_turn?    → stop hooks → return 'completed'                   │   │
│  │  │ maxTurns?    → return 'max_turns'                                │   │
│  │  │ 中断?        → return 'aborted'                                  │   │
│  │  └──────────────────────────────────┘                                │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│       ↓                                                                   │
│  Terminal { reason } → resetLoadingState() → 回到输入状态                  │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```
