# 工具发现系统（ToolSearch）深度分析

> 源码路径：`src/tools/ToolSearchTool/`、`src/utils/toolSearch.ts`、`src/utils/attachments.ts`、`src/services/api/claude.ts`

---

## 一、延迟工具机制

### 1.1 什么是"延迟工具"

延迟工具（Deferred Tool）的完整 JSON Schema **不包含在初始 API 请求中**。模型只看到工具名列表（通过 `<available-deferred-tools>` 块或 `deferred_tools_delta` 附件）。要调用延迟工具，模型必须先通过 ToolSearchTool 发现它，产生 `tool_reference` 内容块，API 据此在后续轮次注入完整 schema。

**目的**：大量 MCP 工具（几十甚至上百个）的 schema 会消耗大量 context token。延迟加载让 context 只包含模型实际需要的工具。

### 1.2 延迟判定逻辑

**文件**：`src/tools/ToolSearchTool/prompt.ts` — `isDeferredTool(tool)`

```
isDeferredTool(tool):
    │
    ├─ tool.alwaysLoad === true → 不延迟（MCP 的 anthropic/alwaysLoad）
    ├─ tool.isMcp === true → 始终延迟
    ├─ tool.name === 'ToolSearch' → 永不延迟（自身豁免）
    ├─ FORK_SUBAGENT + AgentTool + isForkSubagentEnabled() → 不延迟
    ├─ KAIROS/KAIROS_BRIEF + BriefTool → 不延迟（主通信通道）
    ├─ KAIROS + SendUserFileTool + isReplBridgeActive() → 不延迟
    └─ tool.shouldDefer === true → 延迟
```

**关键规则**：MCP 工具**始终延迟**（除非设置了 `alwaysLoad`），因为它们是工作流特定的。

---

## 二、ToolSearchTool

### 2.1 文件清单

| 文件 | 职责 |
|------|------|
| `ToolSearchTool.ts` | 工具定义、查询分发、关键词搜索 |
| `prompt.ts` | 工具名常量、isDeferredTool()、prompt 生成、formatDeferredToolLine() |
| `constants.ts` | `TOOL_SEARCH_TOOL_NAME = 'ToolSearch'` |

### 2.2 输入/输出 Schema

```typescript
// 输入
z.object({
  query: z.string(),                    // 搜索查询或 "select:Name1,Name2"
  max_results: z.number().optional().default(5),
})

// 输出
z.object({
  matches: z.array(z.string()),         // 匹配的工具名
  query: z.string(),                    // 原始查询
  total_deferred_tools: z.number(),     // 可发现工具总数
  pending_mcp_servers: z.array(z.string()).optional(),  // 仍在连接的 MCP 服务器
})
```

### 2.3 两种查询模式

#### `select:` 前缀 — 按名称直接选择

```
select:WebFetch,WebSearch,mcp__slack__send_message
```

- 逗号分隔多选
- 先在延迟工具集查找，再在完整工具集查找
- 选择已加载的工具是无害的 no-op（让模型不必重试）
- 部分找到时返回已找到的子集

#### 关键词搜索 — `searchToolsWithKeywords()`

```
搜索流程：
    │
    ├─ 快速路径：query 精确匹配工具名（不区分大小写）→ 直接返回
    │   （处理子 agent/压缩后用裸名称搜索的情况）
    │
    ├─ MCP 前缀路径：query 以 "mcp__" 开头 → 前缀匹配所有延迟工具
    │
    ├─ 分词 → 分离 +前缀必需词 和 普通词
    │
    ├─ 预编译词边界正则（compileTermPatterns，每搜索一次而非 tools×terms×2 次）
    │
    ├─ 必需词预过滤（如果有 +前缀词 → 仅保留匹配所有必需词的候选）
    │
    └─ 并行评分 → 排序 → 截取 max_results
```

**评分权重**：

| 匹配位置 | 普通工具 | MCP 工具 | 说明 |
|----------|:-------:|:-------:|------|
| 名称部分精确匹配 | 10 | 12 | CamelCase 拆分 / `__` 和 `_` 拆分 |
| 名称部分包含匹配 | 5 | 6 | 子串匹配 |
| 全名回退 | 3 | 3 | 其他都没匹配时 |
| searchHint 词边界匹配 | 4 | 4 | 工具注册时的策划短语 |
| description 词边界匹配 | 2 | 2 | 来自 tool.prompt() 的完整描述 |

MCP 工具权重略高（12 vs 10），因为模型通常按服务器名搜索（如 "slack"、"github"）。

**工具名解析**（`parseToolName()`）：

```
MCP:     "mcp__slack_bot__send_message" → ["slack", "bot", "send", "message"]
Regular: "FileReadTool"                → ["file", "read", "tool"]
```

### 2.4 tool_reference 内容块

搜索结果通过 `mapToolResultToToolResultBlockParam()` 返回：

```typescript
// ø
{
  type: 'tool_result',
  tool_use_id: toolUseID,
  content: matches.map(name => ({
    type: 'tool_reference',
    tool_name: name,
  }))
}

// 无匹配（可能提示 pending 服务器）
{
  type: 'tool_result',
  tool_use_id: toolUseID,
  content: "No matching deferred tools found. Some MCP servers are still connecting: ..."
}
```

API 收到 `tool_reference` 后，在后续 API 调用中注入这些工具的完整 schema。

**兼容性**：`tool_reference` 在 1P/Foundry 上支持。Bedrock/Vertex 暂不支持客户端 tool_reference 扩展。Haiku 模型也不支持（通过 GrowthBook flag `tengu_tool_search_unsupported_models` 配置）。

### 2.5 描述缓存

`getToolDescriptionMemoized` 使用 lodash memoize，按 toolName 缓存 `tool.prompt()` 的结果。当延迟工具集发生变化时（MCP 服务器连接/断开），`maybeInvalidateCache()` 通过比较排序后的工具名拼接字符串检测变化并清除缓存。

---

## 三、工具搜索模式

**文件**：`src/utils/toolSearch.ts`

### 3.1 三种模式

| 模式 | 行为 | 触发条件 |
|------|------|----------|
| `tst` | 所有可延迟工具始终延迟 | 默认；`ENABLE_TOOL_SEARCH` 未设置/`true`/`auto:0` |
| `tst-auto` | 仅当延迟工具 token 超阈值时延迟 | `ENABLE_TOOL_SEARCH=auto` 或 `auto:N`（1-99） |
| `standard` | 不延迟，所有工具内联 | `ENABLE_TOOL_SEARCH=false`/`auto:100`；或 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=true` |

### 3.2 isToolSearchEnabled() — 完整启用检查

```
isToolSearchEnabled(model, tools, ...)
    │
    ├─ modelSupportsToolReference(model)?
    │   └─ haiku → false（pattern 可通过 GrowthBook 实时配置）
    │
    ├─ isToolSearchToolAvailable(tools)?
    │   └─ ToolSearch 不在工具列表中（被 disallowedTools 阻止）→ false
    │
    └─ getToolSearchMode():
        ├─ tst → true
        ├─ standard → false
        └─ tst-auto → checkAutoThreshold()
              ├─ 优先：countToolDefinitionTokens API（精确 token 计数，memoized）
              ├─ 回退：字符数 / 2.5（字符启发式）
              └─ 阈值 = contextWindow × percentage（默认 10%）
```

### 3.3 isToolSearchEnabledOptimistic() — 乐观检查

比 `isToolSearchEnabled` 更宽松，用于：
- 决定是否在 base tools 中包含 ToolSearchTool
- 是否保留 message 中的 tool_reference 字段

额外检查：当 `ENABLE_TOOL_SEARCH` 未设置 + provider 是 firstParty + `ANTHROPIC_BASE_URL` 不是 Anthropic 官方地址 → **禁用**（代理网关通常不支持 `tool_reference`）。但如果用户显式设置了 `ENABLE_TOOL_SEARCH=true/auto/auto:N`，则信任用户的配置。

---

## 四、延迟工具公告机制（Full vs Delta）

延迟工具需要某种方式告诉模型："这些工具名存在，你可以通过 ToolSearch 发现它们。" 有两种实现方式，架构差异很大。

### 4.1 全量模式（默认）—— 临时注入，不持久化

**触发条件**：`!isDeferredToolsDeltaEnabled()`（默认路径）

**关键代码**（`src/services/api/claude.ts:1330`）：

```typescript
if (useToolSearch && !isDeferredToolsDeltaEnabled()) {
  const deferredToolList = tools
    .filter(t => deferredToolNames.has(t.name))
    .map(formatDeferredToolLine)   // → 仅返回 tool.name
    .sort()
    .join('\n')
  if (deferredToolList) {
    messagesForAPI = [
      createUserMessage({
        content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
        isMeta: true,
      }),
      ...messagesForAPI,           // ← 插在所有消息最前面
    ]
  }
}
```

**行为**：
- 在 `messagesForAPI`（即将发送给 API 的消息数组）的**最前面**插入一条合成的用户消息
- 这条消息**不会写入对话历史**（`messages` 数组不变，只有 `messagesForAPI` 局部变量被修改）
- **每次 API 调用都会重新生成**——无论是用户提交新消息、还是工具执行后的下一轮循环
- 内容是**完整的**当前延迟工具名列表（不是增量）

**多轮对话时**：

```
第 1 轮 API 调用:
  [合成] <available-deferred-tools>WebFetch\nWebSearch\nmcp__slack__send\n...</available-deferred-tools>
  [用户] 帮我搜索 xxx
  
第 2 轮 API 调用（模型调用了 ToolSearch 后工具执行完成）:
  [合成] <available-deferred-tools>WebFetch\nWebSearch\nmcp__slack__send\n...</available-deferred-tools>  ← 重新生成
  [用户] 帮我搜索 xxx
  [助手] [tool_use: ToolSearch]
  [用户] [tool_result: tool_reference blocks]
  
第 3 轮 API 调用:
  [合成] <available-deferred-tools>WebFetch\nWebSearch\nmcp__slack__send\n...</available-deferred-tools>  ← 又一次重新生成
  [用户] 帮我搜索 xxx
  [助手] [tool_use: ToolSearch]
  [用户] [tool_result: tool_reference blocks]
  [助手] 搜索结果是...
  [用户] 谢谢，再帮我看看 yyy
```

**所以是的，每轮都加，但只存在一份**——它不在历史中累积，因为它是发送前临时注入的。

**缺点**：注释里说 "which busts cache whenever the pool changes"——当 MCP 服务器异步连接导致工具池变化时，这个前缀消息的内容会改变，导致 Anthropic API 的 prompt cache 失效。

### 4.2 Delta 模式 —— 持久化附件，仅发送差异

**触发条件**：`isDeferredToolsDeltaEnabled()` = `USER_TYPE=ant` 或 `tengu_glacier_2xr` feature flag

**关键代码**（`src/utils/attachments.ts:1460`）：

```typescript
function getDeferredToolsDeltaAttachment(tools, model, messages, scanContext) {
  // ... 前置检查 ...
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext)
  if (!delta) return []                    // 无变化 → 不产生附件
  return [{ type: 'deferred_tools_delta', ...delta }]
}
```

**`getDeferredToolsDelta()`**（`src/utils/toolSearch.ts:646`）的 diff 逻辑：

```typescript
// 1. 重建已公告集合：扫描历史中所有 deferred_tools_delta 附件
const announced = new Set<string>()
for (const msg of messages) {
  if (msg.attachment?.type !== 'deferred_tools_delta') continue
  for (const n of msg.attachment.addedNames) announced.add(n)
  for (const n of msg.attachment.removedNames) announced.delete(n)
}

// 2. Diff：当前延迟工具 vs 已公告
const added = deferred.filter(t => !announced.has(t.name))
const removed = [...announced].filter(n => !deferredNames.has(n) && !poolNames.has(n))
//                                                                  ↑ 取消延迟但仍在池中 → 不报 removed

// 3. 无变化 → 返回 null（不产生附件）
if (added.length === 0 && removed.length === 0) return null
```

**Delta 附件转 API 消息**（`src/utils/messages.ts:4178`）：

```typescript
case 'deferred_tools_delta': {
  const parts: string[] = []
  if (attachment.addedLines.length > 0) {
    parts.push(
      `The following deferred tools are now available via ToolSearch:\n${attachment.addedLines.join('\n')}`
    )
  }
  if (attachment.removedNames.length > 0) {
    parts.push(
      `The following deferred tools are no longer available (their MCP server disconnected). Do not search for them — ToolSearch will return no match:\n${attachment.removedNames.join('\n')}`
    )
  }
  return wrapMessagesInSystemReminder([
    createUserMessage({ content: parts.join('\n\n'), isMeta: true })
  ])
}
```

**行为**：
- 附件消息是 `{ type: 'attachment' }` 类型，**写入对话历史**（`messages` 数组）
- 在 `normalizeMessagesForAPI()` 阶段，附件消息通过 `normalizeAttachmentForAPI()` 转为 `<system-reminder>` 包裹的用户消息
- **仅在工具池发生变化时产生**（新 MCP 服务器连接、断开等）
- 历史中可能有**多个** delta 附件，每个记录一次变化事件

**多轮对话时**：

```
对话开始（MCP 连接完成后，第一轮 getAttachments）:
  messages 中新增: [attachment: deferred_tools_delta { added: [WebFetch, WebSearch, mcp__slack__*...] }]

第 1 轮 API 调用:
  [system-reminder] The following deferred tools are now available via ToolSearch: WebFetch, WebSearch, ...
  [用户] 帮我搜索 xxx

第 2 轮 API 调用（工具池未变化，getDeferredToolsDelta() 返回 null，不产生新附件）:
  [system-reminder] The following deferred tools are now available via ToolSearch: WebFetch, WebSearch, ...  ← 同一条历史附件
  [用户] 帮我搜索 xxx
  [助手] ...
  [用户] ...

（此时新 MCP 服务器 github 异步连接成功，工具池新增 mcp__github__*）

第 3 轮 API 调用:
  [system-reminder] The following deferred tools are now available via ToolSearch: WebFetch, WebSearch, ...  ← 第一次的附件
  [用户] 帮我搜索 xxx
  [助手] ...
  [system-reminder] The following deferred tools are now available via ToolSearch: mcp__github__create_issue, ...  ← 新增的 delta
  [用户] 谢谢，再帮我看看 yyy
```

### 4.3 Delta 的粒度：每条只是 diff，不是全量

每个 `deferred_tools_delta` 附件只包含**那一次变化事件的增量**。模型在历史中看到的是多条独立的 `<system-reminder>`，需要自己"回放"才能推断当前可用集合：

```
[system-reminder] The following deferred tools are now available via ToolSearch:
WebFetch, WebSearch, mcp__slack__send_message, mcp__slack__list_channels

... (对话进行) ...

[system-reminder] The following deferred tools are now available via ToolSearch:
mcp__github__create_issue, mcp__github__list_repos

... (slack 断开) ...

[system-reminder] The following deferred tools are no longer available
(their MCP server disconnected). Do not search for them —
ToolSearch will return no match:
mcp__slack__send_message, mcp__slack__list_channels
```

模型需要从三条消息推断：当前可用 = WebFetch + WebSearch + mcp\_\_github\_\_\*。

### 4.4 工具删除的三种情况

`getDeferredToolsDelta()` 的 removal 判定逻辑（`src/utils/toolSearch.ts:670`）：

```typescript
for (const n of announced) {
  if (deferredNames.has(n)) continue     // 仍在延迟池 → 无事发生
  if (!poolNames.has(n)) removed.push(n) // 完全消失 → 报告 removed
  // else: undeferred — silent           // 在池中但不再延迟 → 静默
}
```

| 场景 | 条件 | 结果 |
|------|------|------|
| **MCP 服务器断开**，工具从池中消失 | `!deferredNames && !poolNames` | 生成 removed：`"no longer available ... Do not search for them"` |
| **工具从延迟→直接加载**（如设了 `alwaysLoad`） | `!deferredNames && poolNames` | **静默不报告**。工具仍可用，只是不再需要通过 ToolSearch 发现 |
| **工具仍在延迟池** | `deferredNames.has(n)` | 跳过，无变化 |

设计意图：只有工具**真正不可用**时才告诉模型 "no longer available"。如果工具只是从延迟→直接加载（仍在 `poolNames` 中），告诉模型它消失了反而会造成误导。

### 4.5 压缩后的"全量重置"

压缩会吞掉历史中的旧 delta 附件消息。压缩代码用两种方式处理：

**全量压缩**（所有消息被摘要替换）——传入空消息数组，等于 diff against nothing：

```typescript
// compact.ts:567
// "Empty message history → diff against nothing → announces the full set"
getDeferredToolsDeltaAttachment(tools, model, [], { callSite: 'compact_full' })
```

`announced` 集合为空 → 所有当前延迟工具都算"新增" → 生成一条包含**完整列表**的 delta，效果等同全量重置。

**部分压缩**（保留部分消息）——传入 `messagesToKeep`：

```typescript
// compact.ts:957
// "Re-announce only what was in the summarized portion"
getDeferredToolsDeltaAttachment(tools, model, messagesToKeep, { callSite: 'compact_partial' })
```

扫描 `messagesToKeep` 中存活的 delta 附件重建 `announced`，只重新公告被摘要吞掉的那部分。

### 4.6 对比总结

| 维度 | 全量模式 | Delta 模式 |
|------|---------|-----------|
| **持久化** | 不持久化——每次 API 调用临时注入，调用后丢弃 | 持久化到对话历史（attachment 消息） |
| **内容** | 完整的当前延迟工具名列表 | 仅变化部分（新增/移除） |
| **频率** | 每次 API 调用都生成 | 仅工具池变化时生成（大多数轮次为空） |
| **在历史中累积** | 不累积——只有一份，每次覆盖重建 | 累积——每次变化产生新附件消息 |
| **API 注入位置** | 所有消息最前面（position 0） | 按照附件的冒泡规则放置（`reorderAttachmentsForAPI`） |
| **Prompt Cache** | 工具池变化时缓存失效（前缀内容变了） | 缓存稳定（新消息追加在末尾，不影响前缀） |
| **模型看到的格式** | `<available-deferred-tools>Name1\nName2\n...</available-deferred-tools>` | `<system-reminder>The following deferred tools are now available via ToolSearch:\nName1\nName2\n...</system-reminder>` |
| **启用条件** | 默认 | `USER_TYPE=ant` 或 `tengu_glacier_2xr` feature flag |
| **设计动机** | 简单可靠 | 优化 prompt cache 命中率 |

**核心区别**：全量模式像一个"每次刷新的公告板"；Delta 模式像一个"只记录变更的日志流"。Delta 模式的设计动机是 Anthropic API 的 prompt caching——消息数组的前缀不变则缓存可复用。全量模式在 position 0 注入一条随工具池变化的消息，破坏了前缀稳定性。

---

## 五、发现历史追踪

**`extractDiscoveredToolNames(messages)`**：扫描消息历史中的 `tool_reference` 块，重建已发现工具集。仅已被发现的延迟工具会包含在后续 API 调用中。

**压缩兼容**：压缩时 `tool_reference` 所在消息被替换为摘要，但已发现工具集快照到 `compactMetadata.preCompactDiscoveredTools` 中，在 compact_boundary 标记上恢复。Snip 则直接保护包含 `tool_reference` 的消息不被移除。

---

## 六、配置项速查

### 环境变量

| 变量 | 说明 |
|------|------|
| `ENABLE_TOOL_SEARCH` | `true`/`false`/`auto`/`auto:N` — 工具搜索模式 |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 强制 standard 模式（禁用 tool_reference） |

### Feature Flags

| Flag | 说明 |
|------|------|
| `tengu_glacier_2xr` | 启用 deferred_tools_delta 附件模式（Delta） |
| `tengu_tool_search_unsupported_models` | 不支持 tool_reference 的模型 pattern 列表（默认 `['haiku']`） |
