# Claude Code 压缩机制分析

> 源码路径：`src/services/compact/`、`src/commands/compact/compact.ts`

---

## 一、总体设计

Claude Code 的压缩机制（Compact）目的是在对话 token 数接近模型上下文窗口上限时，把历史对话压缩成一段结构化摘要，腾出空间以继续工作。整套系统包含四条触发路径、三层压缩策略、以及一套精细的压缩后重建流程。

---

## 二、触发机制

### 2.1 阈值计算

```
effectiveContextWindow = modelContextWindow - min(modelMaxOutput, 20_000)
autoCompactThreshold   = effectiveContextWindow - 13_000   (AUTOCOMPACT_BUFFER_TOKENS)
warningThreshold       = autoCompactThreshold - 20_000     (WARNING_THRESHOLD_BUFFER_TOKENS)
hardBlockLimit         = effectiveContextWindow - 3_000    (MANUAL_COMPACT_BUFFER_TOKENS)
```

- 默认上下文窗口：200K token（支持 1M 的模型则为 1M）。
- `autoCompactThreshold`：超过此值时自动触发压缩。
- `warningThreshold`：超过此值时 UI 显示警告，但不压缩。
- `hardBlockLimit`：超过此值时拒绝新消息，直至压缩完成。

### 2.2 四条触发路径

| 路径 | 文件 | 触发条件 |
|------|------|----------|
| **自动压缩（Auto-compact）** | `autoCompact.ts` | token 数超过 `autoCompactThreshold` |
| **手动命令** | `commands/compact/compact.ts` | 用户执行 `/compact [自定义指令]` |
| **被动压缩（Reactive）** | 特性标志 `REACTIVE_COMPACT` | API 返回 `prompt_too_long` (413) 错误 |
| **部分压缩（Partial）** | `partialCompactConversation()` | 用户在 UI 中选择某条消息作为压缩边界 |

### 2.3 抑制条件

以下情况会跳过自动压缩：

- 环境变量 `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT`
- 用户配置 `autoCompactEnabled: false`
- `querySource` 为 `'session_memory'` 或 `'compact'`（防递归）
- 特性标志 `tengu_cobalt_raccoon`（切换为仅被动模式）
- 连续失败 3 次（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`）后熔断

---

## 三、压缩策略（优先级由高到低）

### 策略 1：Session Memory Compact（实验性，Anthropic 内部）

**文件**：`sessionMemoryCompact.ts`

需同时开启 `tengu_session_memory` + `tengu_sm_compact` 特性标志。

- 直接用已有的持续更新 `sessionMemory` 文件作为摘要，**无需额外 API 调用**。
- 确定保留消息的起始索引（`startIndex`），从 `lastSummarizedMessageId` 向前扩展，直到满足：
  - `minTokens = 10_000`（至少保留 1 万 token 的近期消息）
  - `minTextBlockMessages = 5`（至少保留 5 条含文本的消息）
  - `maxTokens = 40_000`（保留消息的硬上限）
- 自动调整边界，避免拆分 `tool_use`/`tool_result` 对或 thinking block。
- 若压缩后 token 仍超阈值，回退到策略 3。

### 策略 2：Micro-compact（预处理，减少 token 再调用 LLM）

**文件**：`microCompact.ts`

在发送给 LLM 之前先清理旧工具结果，减少上下文体积。

**子路径 A：基于时间（Time-based Microcompact）**
- 若距上一条 assistant 消息超过配置的时间阈值，将所有「可压缩工具」的旧结果替换为 `'[Old tool result content cleared]'`。
- 可压缩工具：`Read`、`Bash`/shell、`Grep`、`Glob`、`WebSearch`、`WebFetch`、`Edit`、`Write`。

**子路径 B：Cached Microcompact（Anthropic 内部，`CACHED_MICROCOMPACT` 标志）**
- 利用 API 的 `cache_edits` 功能在服务端删除旧工具结果，不修改本地消息，也不使 prompt cache 失效。

### 策略 3：LLM 全量摘要（主路径）

**文件**：`compact.ts` → `compactConversation()`

1. 替换消息中的图片/文档块为 `[image]`/`[document]` 文本占位符。
2. 移除重新注入的 skill 附件。
3. 调用 `streamCompactSummary()`，将完整历史消息 + 压缩提示词发给模型。
4. 若 API 返回 `prompt_too_long`，调用 `truncateHeadForPTLRetry()` 从头部删除若干轮对话（最多重试 3 次，`MAX_PTL_RETRIES`）。
5. 解析响应中的 `<analysis>...</analysis><summary>...</summary>` XML。
6. 丢弃 `<analysis>` 块，将 `<summary>` 内容格式化为 `Summary:\n[内容]`。

---

## 四、压缩提示词

**文件**：`prompt.ts` → `getCompactPrompt()`

### 系统提示词

```
You are a helpful AI assistant tasked with summarizing conversations.
```

（关闭 thinking，使用相同主模型，最多输出 20,000 token）

### 正文结构

提示词要求模型先在 `<analysis>` 标签内草稿分析（scratchpad），再输出 `<summary>`，`<analysis>` 内容最终会被丢弃。

`<summary>` 要求包含 9 个结构化部分：

| # | 章节 | 内容 |
|---|------|------|
| 1 | Primary Request and Intent | 用户所有明确请求 |
| 2 | Key Technical Concepts | 技术栈、框架、关键概念 |
| 3 | Files and Code Sections | 查看/修改/创建的文件及完整代码片段 |
| 4 | Errors and Fixes | 遇到的错误及解决方式 |
| 5 | Problem Solving | 已解决问题与进行中问题 |
| 6 | All User Messages | 每条用户消息的逐字记录 |
| 7 | Pending Tasks | 明确要求但尚未完成的任务 |
| 8 | Current Work | 压缩发生时正在做的事 |
| 9 | Optional Next Step | 与最新请求一致的下一步，含直接引用 |

头尾各有 `NO_TOOLS_PREAMBLE` / `NO_TOOLS_TRAILER`，强制要求模型不调用任何工具，仅输出纯文本。

### 变体提示词

- `PARTIAL_COMPACT_PROMPT`：仅摘要边界之后的"近期消息"。
- `PARTIAL_COMPACT_UP_TO_PROMPT`：摘要边界之前的消息，第 9 节改为"Context for Continuing Work"。
- 自定义指令：`/compact [text]` 或 pre-compact hook 提供的文本，附加在基础提示词后。

---

## 五、压缩后的消息结构

**文件**：`buildPostCompactMessages()`

压缩完成后，新的消息数组按以下顺序重建：

```
[boundaryMarker]      // SystemCompactBoundaryMessage — 元数据哨兵
[summaryMessages]     // 单条 UserMessage，包含格式化摘要
[messagesToKeep]      // 仅 SM-compact / partial-compact 时保留的近期消息
[attachments]         // 重新注入：最近读取的文件 + agent 状态 + plan + skill 内容
[hookResults]         // SessionStart hook 输出（如 CLAUDE.md 内存）
```

### boundaryMarker（`SystemCompactBoundaryMessage`）

记录压缩元数据：
- `trigger`：`'auto'` 或 `'manual'`
- `preCompactTokenCount`：压缩前 token 数
- `compactMetadata.preCompactDiscoveredTools`：压缩前发现的工具名称
- `compactMetadata.preservedSegment`：保留消息段的 UUID 范围（SM/partial 模式）

### summaryMessages

一条 `UserMessage`，特征：
- `isCompactSummary: true`
- `isVisibleInTranscriptOnly: true`（全量压缩）
- 内容前缀：`"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation."`

### 文件重注入（`createPostCompactFileAttachments`）

压缩后自动重新注入最近读取的文件，约束如下：

| 参数 | 值 |
|------|----|
| 最多文件数 | 5 |
| 总 token 预算 | 50,000 |
| 单文件上限 | 5,000 token |
| 单 skill 上限 | 5,000 token |
| skill 总预算 | 25,000 token |

已在保留消息中出现的文件会跳过。

---

## 六、API 调用优化

**Prompt Cache 共享**（`tengu_compact_cache_prefix` 标志，默认开启）

压缩调用作为 **forked agent** 运行，复用主对话的 prompt cache 前缀（相同系统提示、工具列表、模型），避免缓存失效。失败时回退为直接流式调用（`querySource: 'compact'`），工具限制为仅 `[FileReadTool]`。

---

## 七、压缩后清理

**函数**：`runPostCompactCleanup()`

- 重置 microcompact 状态
- 重置 context-collapse 状态
- 清除 `getUserContext` 缓存
- 清除 CLAUDE.md 内存文件缓存
- 清除系统提示节、分类器审批、推测性检查状态
- 清除 beta tracing 状态和 session 消息缓存

---

## 八、配置项速查

### 用户配置（`~/.claude/settings.json`）

| 键 | 类型 | 说明 |
|----|------|------|
| `autoCompactEnabled` | boolean | 开启/关闭自动压缩（默认 `true`） |

### 环境变量

| 变量 | 说明 |
|------|------|
| `DISABLE_COMPACT` | 禁用所有压缩（含手动） |
| `DISABLE_AUTO_COMPACT` | 仅禁用自动压缩 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 以百分比覆盖触发阈值（0–100） |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 覆盖计算阈值用的上下文窗口大小 |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | 覆盖硬阻断 token 上限 |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | 禁用 1M token 上下文窗口 |
| `ENABLE_CLAUDE_CODE_SM_COMPACT` | 强制启用 Session Memory 压缩 |
| `DISABLE_CLAUDE_CODE_SM_COMPACT` | 强制禁用 Session Memory 压缩 |

---

## 九、数据流总览

```
用户消息 → token 计数
    │
    ├─ < warningThreshold       → 正常继续
    ├─ warningThreshold ~ limit → UI 警告
    ├─ > autoCompactThreshold   → 触发自动压缩
    └─ > hardBlockLimit         → 拒绝新消息

自动压缩流程：
    shouldAutoCompact()
        └─ trySessionMemoryCompaction()   [策略 1，实验性]
               ↓ 失败/不可用
           microcompactMessages()         [策略 2，预处理]
               ↓
           compactConversation()          [策略 3，LLM 摘要]
               ↓
           buildPostCompactMessages()     [重建消息数组]
               ↓
           runPostCompactCleanup()        [清理状态]
```
