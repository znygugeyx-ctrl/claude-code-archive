# Claude Agent SDK 与 Claude Code 源码关系分析

> SDK 文档：https://platform.claude.com/docs/zh-CN/agent-sdk/overview
> 源码路径：`src/QueryEngine.ts`、`src/cli/print.ts`、`src/cli/structuredIO.ts`、`src/entrypoints/`

---

## 一、核心结论：Agent SDK 是 Claude Code 的子进程封装

**Claude Agent SDK 不是独立产品**。它是一层薄封装（thin wrapper），通过 **子进程 + NDJSON stdio 协议** 驱动完整的 Claude Code CLI。

```
SDK 消费者代码（Python / TypeScript）
    │  query({ prompt, options })
    ▼
@anthropic-ai/claude-agent-sdk（sdk.mjs）
    │  ProcessTransport.initialize()
    ▼
spawn("node", ["cli.js", "--output-format", "stream-json", ...])
    │  stdio: ['pipe', 'pipe', 'pipe']
    ▼
Claude Code CLI（main.tsx → print.ts → runHeadless()）
    │  StructuredIO 解析 stdin NDJSON
    │  runHeadlessStreaming() 多轮循环
    ▼
QueryEngine.submitMessage()
    │  → processUserInput() → fetchSystemPromptParts() → query()（API 调用）
    │  → yield SDKMessage
    ▼
StructuredIO.write() → stdout NDJSON → SDK ProcessTransport.readMessages()
    │
    ▼
SDK 消费者收到 AsyncIterator<SDKMessage>
```

**关键事实**：
- SDK 包（`@anthropic-ai/claude-agent-sdk`）内部打包了一份完整的 Claude Code CLI（`cli.js`）
- 每次 `query()` 调用实质上是 `spawn` 一个 Claude Code 进程
- SDK 的工具、压缩、Agent 循环、权限系统**全部复用** Claude Code 的实现
- SDK 没有自己的 API 调用逻辑、工具执行逻辑或 Agent 循环

---

## 二、架构层次对照

```
┌─────────────────────────────────────────────────────────────────┐
│                      SDK 消费者代码                              │
│   query({ prompt: "Fix bug", options: { allowedTools: [...] }}) │
└───────────────────────────┬─────────────────────────────────────┘
                            │ AsyncIterator<SDKMessage>
┌───────────────────────────▼─────────────────────────────────────┐
│             @anthropic-ai/claude-agent-sdk                       │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ ProcessTransport                                        │     │
│  │  - spawn CLI 子进程                                     │     │
│  │  - SDK Options → CLI flags 转换                         │     │
│  │  - NDJSON stdin/stdout 双向通信                          │     │
│  │  - control_request / control_response 协议              │     │
│  └────────────────────────────────────────────────────────┘     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ WebSocketTransport（可选）                               │     │
│  │  - 远程会话，cc:// 协议                                  │     │
│  └────────────────────────────────────────────────────────┘     │
└───────────────────────────┬─────────────────────────────────────┘
                            │ stdio (NDJSON)
┌───────────────────────────▼─────────────────────────────────────┐
│               Claude Code CLI（Headless 模式）                   │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ print.ts → runHeadless() → runHeadlessStreaming()       │     │
│  │  - 读取 initialize control_request                      │     │
│  │  - 配置 hooks, agents, permissions                      │     │
│  │  - 构建 StructuredIO                                    │     │
│  └──────────────────────────┬─────────────────────────────┘     │
│  ┌──────────────────────────▼─────────────────────────────┐     │
│  │ QueryEngine.submitMessage()                             │     │
│  │  - fetchSystemPromptParts()                             │     │
│  │  - processUserInput()                                   │     │
│  │  - query() → queryLoop() ← 完整的 Agent 主循环          │     │
│  │  - yield SDKMessage                                     │     │
│  └──────────────────────────┬─────────────────────────────┘     │
│  ┌──────────────────────────▼─────────────────────────────┐     │
│  │ 共享基础设施                                             │     │
│  │  - API 客户端（claude.ts）                               │     │
│  │  - 工具系统（src/tools/）                                │     │
│  │  - 权限系统（src/utils/permissions/）                    │     │
│  │  - 压缩系统（src/services/compact/）                     │     │
│  │  - MCP 客户端（src/services/mcp/）                       │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、SDK Options 到 CLI Flags 的映射

SDK 的 `Options` 类型不是直接传给内部函数，而是**转换为 CLI 命令行参数**：

| SDK Option | CLI Flag | 说明 |
|---|---|---|
| `model` | `--model` | 模型选择 |
| `maxTurns` | `--max-turns` | 最大轮次 |
| `maxBudgetUsd` | `--max-budget-usd` | 费用上限 |
| `systemPrompt` | initialize `control_request` | 自定义系统提示词 |
| `permissionMode` | `--permission-mode` | 权限模式 |
| `allowedTools` | `--allowedTools` | 允许的工具列表 |
| `disallowedTools` | `--disallowedTools` | 禁止的工具列表 |
| `mcpServers` | `--mcp-config` (JSON) | MCP 服务器配置 |
| `agents` | initialize `control_request` | 子 agent 定义 |
| `hooks` | initialize `control_request` | 钩子回调 |
| `resume` | `--resume` | 会话恢复 |
| `continue` | `--continue` | 继续对话 |
| `includePartialMessages` | `--include-partial-messages` | 流式部分消息 |
| `jsonSchema` | `--json-schema` | 结构化输出 |
| `canUseTool` | `--permission-prompt-tool stdio` | 权限回调 |

CLI 始终带有 `--output-format stream-json --verbose --input-format stream-json`，进入 headless NDJSON 模式。

---

## 四、通信协议：NDJSON + Control Protocol

### 4.1 消息方向

| 方向 | 载体 | 内容 |
|------|------|------|
| **CLI → SDK**（stdout） | NDJSON | `SDKMessage`（assistant/user/result/system/stream_event）+ `control_request`（权限/钩子/选择） |
| **SDK → CLI**（stdin） | NDJSON | `SDKUserMessage`（新提示）+ `control_response`（权限决定/钩子结果） |

### 4.2 控制协议（Control Protocol）

当 CLI 需要 SDK 宿主做决定时，使用 `control_request`/`control_response` 对：

**权限请求流程**：
```
CLI:  → stdout: { type: "control_request", subtype: "can_use_tool",
                   tool_name: "Bash", input: {...}, permission_suggestions: [...] }
SDK:  ← stdin:  { type: "control_response", subtype: "can_use_tool",
                   behavior: "allow", updatedInput: {...} }
```

**钩子回调流程**：
```
CLI:  → stdout: { type: "control_request", subtype: "hook_callback",
                   callback_id: "abc123", input: { hook_event_name: "PreToolUse", ... } }
SDK:  ← stdin:  { type: "control_response", subtype: "hook_callback",
                   callback_id: "abc123", output: { permissionDecision: "allow" } }
```

**初始化流程**：
```
SDK:  → stdin:  { type: "control_request", subtype: "initialize",
                   agents: {...}, hooks: {...}, systemPrompt: "...",
                   appendSystemPrompt: "..." }
CLI:  读取后配置内部状态
```

### 4.3 SDKMessage 类型清单

**文件**：`src/entrypoints/sdk/coreSchemas.ts`

| Schema | type/subtype | 用途 |
|--------|-------------|------|
| `SDKAssistantMessage` | `assistant` | Claude 的响应（含 `message`、`parent_tool_use_id`） |
| `SDKUserMessage` | `user` | 用户输入 |
| `SDKUserMessageReplay` | `user` + `isReplay` | 回放确认 |
| `SDKResultSuccess` | `result/success` | 成功结果（`result`、`usage`、`total_cost_usd`、`structured_output`） |
| `SDKResultError` | `result/error_*` | 错误结果（`error_max_turns`/`error_during_execution`/`error_max_budget_usd`） |
| `SDKSystemMessage` | `system/init` | 会话元数据（`tools`、`mcp_servers`、`model`、`permissionMode`） |
| `SDKCompactBoundary` | `system/compact_boundary` | 压缩边界标记 |
| `SDKPartialAssistant` | `stream_event` | 原始流式事件（需 `includePartialMessages`） |
| `SDKAPIRetry` | `system/api_retry` | API 重试通知 |
| `SDKToolProgress` | `tool_progress` | 工具执行进度 |
| `SDKToolUseSummary` | `tool_use_summary` | 工具调用摘要 |
| `SDKStatus` | `system/status` | 状态更新（如 `compacting`） |
| `SDKSessionStateChanged` | `system/session_state_changed` | 会话状态变更（`idle`/`running`/`requires_action`） |

---

## 五、关键桥接点：QueryEngine

### 5.1 QueryEngine 在架构中的位置

**文件**：`src/QueryEngine.ts`

```
REPL（交互模式）─────────────┐
                              ├──→ query() → queryLoop()  ← 共享的 Agent 主循环
QueryEngine（SDK/Headless）──┘
```

REPL 和 QueryEngine 是**同一个 Agent 主循环的两个入口**。REPL 用于交互式 CLI，QueryEngine 用于 SDK headless 模式。

### 5.2 QueryEngine 核心流程

```typescript
class QueryEngine {
  // 构造函数接收配置
  constructor(config: QueryEngineConfig) {
    // cwd, tools, commands, mcpClients, agents,
    // canUseTool, customSystemPrompt, maxTurns, maxBudgetUsd, ...
  }

  // 主入口：每次调用 = 一次完整对话轮
  async *submitMessage(prompt, options?): AsyncGenerator<SDKMessage> {
    // 1. 包装 canUseTool 以追踪权限拒绝
    // 2. fetchSystemPromptParts() 获取系统提示
    // 3. processUserInput() 处理用户输入（斜杠命令/图片/skill）
    // 4. yield buildSystemInitMessage() → SDKSystemMessage
    // 5. for await (event of query({...})) → 内层 Agent 主循环
    // 6. 将内部 Message 转换为 SDKMessage 并 yield
    // 7. yield SDKResultMessage (success/error)
  }
}

// 便捷包装：一次性使用
async function* ask(params): AsyncGenerator<SDKMessage> {
  const engine = new QueryEngine(config)
  yield* engine.submitMessage(prompt, options)
  // cleanup
}
```

### 5.3 内部 Message → SDKMessage 转换

在 `submitMessage()` 的 for-await 循环中（line 757+），每个内部事件被转换：

| 内部类型 | 转换为 SDK 类型 |
|----------|----------------|
| `AssistantMessage` | `SDKAssistantMessage`（添加 `uuid`、`session_id`、`parent_tool_use_id`） |
| `UserMessage`（工具结果） | `SDKUserMessage`（添加 `tool_use_result` 标记） |
| `SystemAPIErrorMessage` | `SDKAPIRetryMessage` |
| `SystemCompactBoundaryMessage` | `SDKCompactBoundaryMessage` |
| `ToolUseSummaryMessage` | `SDKToolUseSummaryMessage` |
| `StreamEvent` | `SDKPartialAssistantMessage`（仅当 `includePartialMessages`） |
| 工具进度事件 | `SDKToolProgressMessage` |
| 循环终止 | `SDKResultMessage`（success/error_max_turns/error_during_execution） |

---

## 六、SDK 功能与 Claude Code 内部实现的映射

### 6.1 内置工具

| SDK 工具名 | Claude Code 内部工具 | 文件 |
|-----------|---------------------|------|
| `Read` | `FileReadTool` | `src/tools/FileReadTool/` |
| `Write` | `FileWriteTool` | `src/tools/FileWriteTool/` |
| `Edit` | `FileEditTool` | `src/tools/FileEditTool/` |
| `Bash` | `BashTool` | `src/tools/BashTool/` |
| `Glob` | `GlobTool` | `src/tools/GlobTool/` |
| `Grep` | `GrepTool` | `src/tools/GrepTool/` |
| `WebSearch` | `WebSearchTool` | `src/tools/WebSearchTool/` |
| `WebFetch` | `WebFetchTool` | `src/tools/WebFetchTool/` |
| `AskUserQuestion` | `AskUserQuestionTool` | `src/tools/AskUserQuestionTool/` |
| `Task` | `AgentTool` | `src/tools/AgentTool/` |
| `NotebookEdit` | `NotebookEditTool` | `src/tools/NotebookEditTool/` |

SDK 暴露的工具名是 Claude Code 内部工具的 `userFacingName`，不是 `name`。

### 6.2 权限系统

SDK 权限模式直接映射到 Claude Code 的 `PermissionMode`：

| SDK `permissionMode` | 内部行为 |
|---------------------|---------|
| `'default'` | 未匹配工具触发 `canUseTool` 回调（→ `control_request`） |
| `'acceptEdits'` | 文件操作自动批准，其他触发回调 |
| `'bypassPermissions'` | 全部自动批准（子 agent 继承） |
| `'plan'` | 只读，不执行工具 |

**SDK `canUseTool` 回调的内部实现**：

**文件**：`src/cli/structuredIO.ts`（line 533）

```
SDK canUseTool callback
    ↓ 映射为
StructuredIO.createCanUseTool()
    ↓ 当权限判定为 'ask' 时
    ↓ 并行竞争（race）：
    ├─ executePermissionRequestHooksForSDK()  // PermissionRequest hooks
    └─ sendRequest({ subtype: 'can_use_tool' })  // → control_request → SDK 宿主
    ↓ 先返回者胜出
    ↓ SDK 宿主调用用户的 canUseTool 回调
    ↓ 返回 control_response
    ↓
PermissionResult { behavior: 'allow'|'deny', updatedInput?, ... }
```

### 6.3 Hooks 系统

SDK 的函数钩子通过 `control_request`/`control_response` 协议桥接到内部 hook 系统：

**文件**：`src/cli/print.ts`（line 4435）

```
SDK hooks: { PreToolUse: [{ matcher: "Bash", hooks: [myCallback] }] }
    ↓ initialize control_request
CLI: registerHookCallbacks()
    ↓ 为每个回调创建
StructuredIO.createHookCallback(callbackId, timeout)
    ↓ 类型: 'callback'（代替 'command'/'prompt'/'http'）
    ↓ 当 hook 事件触发时：
CLI → stdout: control_request { subtype: 'hook_callback', callback_id, input }
SDK → stdin:  control_response { callback_id, output: HookJSONOutput }
```

与 Claude Code 交互模式的 hook 类型对照：

| Claude Code Hook 类型 | SDK Hook 类型 | 执行方式 |
|----------------------|--------------|---------|
| `command`（shell 命令） | `callback`（函数） | CLI 执行 shell / SDK 通过 stdio 回调 |
| `prompt`（LLM 评估） | `callback`（函数） | LLM 判断 / SDK 通过 stdio 回调 |
| `http`（HTTP 端点） | `callback`（函数） | HTTP 调用 / SDK 通过 stdio 回调 |
| `function`（进程内） | `callback`（函数） | 直接调用 / SDK 通过 stdio 回调 |

SDK 统一使用 `callback` 类型，所有钩子逻辑都在 SDK 宿主进程中执行。

### 6.4 子 Agent（Subagents）

SDK 的 `agents` 参数通过 `initialize` control request 传入：

**文件**：`src/tools/AgentTool/loadAgentsDir.ts`

```
SDK agents: {
  "code-reviewer": {
    description: "...", prompt: "...", tools: ["Read"], model: "sonnet"
  }
}
    ↓ initialize control_request
print.ts: parseAgentsFromJson(request.agents, 'flagSettings')
    ↓ 转换为内部 AgentDefinition
QueryEngine.config.agents
    ↓ 设置到
processUserInputContext.options.agentDefinitions.activeAgents
    ↓ Claude 通过 Task 工具调用时
AgentTool.call() → 创建子 QueryEngine → 子 query() 循环
```

`AgentDefinition` 内部 schema（`coreSchemas.ts` line 1110）比文档公开的更丰富：

| 公开字段 | 内部额外字段 |
|---------|-------------|
| `description`、`prompt`、`tools`、`model` | `disallowedTools`、`mcpServers`、`skills`、`initialPrompt`、`maxTurns`、`background`、`memory`、`effort`、`permissionMode` |

### 6.5 MCP 集成

SDK 的 MCP 配置通过 `--mcp-config` CLI flag 传入，由内部 `MCPConnectionManager` 处理：

| SDK MCP 类型 | 内部传输 |
|-------------|---------|
| `stdio`（command + args） | `StdioClientTransport` |
| `sse`（url + headers） | `SSEClientTransport` |
| `http`（url + headers） | `StreamableHTTPClientTransport` |
| `sdk`（进程内 MCP Server） | SDK 在宿主侧运行 Server，通过 stdio 桥接 |

SDK 的 `createSdkMcpServer()` 创建的进程内 MCP Server 比较特殊——它在 SDK 宿主进程中运行，工具调用通过 control protocol 中继回 SDK 宿主。

### 6.6 会话管理

| SDK 操作 | 内部实现 |
|---------|---------|
| 新会话 | 启动新 CLI 进程，自动创建 session ID |
| `resume: sessionId` | CLI `--resume` flag，加载 `~/.claude/sessions/<id>/` 中的历史 |
| `forkSession: true` | CLI `--fork` flag，复制会话到新 ID |
| `continue: true` | CLI `--continue` flag，继续最近会话 |

### 6.7 压缩系统

SDK 完整复用 Claude Code 的压缩系统（详见 `compression.md`）：

- 自动压缩在 Agent 主循环内自动触发
- SDK 通过 `SDKCompactBoundaryMessage` 通知消费者
- `PreCompact` hook 允许 SDK 消费者在压缩前拦截
- `SDKStatusMessage` 的 `compacting` 子类型通知压缩状态

---

## 七、SDK 独有功能（Claude Code CLI 没有的）

| SDK 功能 | 说明 |
|---------|------|
| **自定义工具**（`createSdkMcpServer` + `tool()`） | 在 SDK 宿主进程内定义 MCP 工具，无需外部 Server |
| **`canUseTool` 回调** | 编程式权限审批（CLI 用交互式 TUI 替代） |
| **函数式 Hooks** | 直接用函数定义钩子（CLI 用 shell command / HTTP） |
| **`maxBudgetUsd`** | 费用上限控制 |
| **`outputFormat` / `jsonSchema`** | 结构化输出 |
| **`AskUserQuestion` 编程处理** | 多选问题的编程式回答（CLI 用 TUI 交互） |
| **`forkSession`** | 会话分叉 |
| **`includePartialMessages`** | 原始流式事件暴露 |
| **`plugins`** | 本地插件加载 |
| **`sandbox`** | 编程式沙箱配置 |
| **V2 Preview**（`send()`/`receive()`） | 简化的多轮对话接口 |

---

## 八、Python SDK vs TypeScript SDK 差异

| 特性 | Python SDK | TypeScript SDK |
|------|-----------|---------------|
| **核心 API** | `query()` + `ClaudeSDKClient` | `query()` |
| **多轮对话** | `ClaudeSDKClient`（复用会话） | `query()` + `resume` |
| **Hooks** | 仅 PreToolUse/PostToolUse/UserPromptSubmit/Stop/SubagentStop/PreCompact | 全部 12 种事件 |
| **自定义工具** | 仅 `ClaudeSDKClient` 支持 | `query()` 直接支持 |
| **中断** | 仅 `ClaudeSDKClient` 支持 | `query().interrupt()` |
| **Hook 类型** | `@tool` 装饰器 | `tool()` 函数 + Zod |

Python SDK 的 `ClaudeSDKClient` 提供更丰富的会话控制，而 `query()` 是无状态的一次性调用。

---

## 九、数据流总览

```
SDK 消费者
    │
    │  query({ prompt: "Fix bug", options: { allowedTools: [...], hooks: {...} }})
    ▼
ProcessTransport
    │  1. spawn("node", ["cli.js", "--output-format", "stream-json", ...])
    │  2. stdin ← initialize control_request (agents, hooks, systemPrompt)
    │  3. stdin ← SDKUserMessage (prompt)
    ▼
Claude Code CLI (Headless)
    │  print.ts → runHeadless() → StructuredIO
    │  解析 initialize → 配置 hooks, agents, permissions
    ▼
QueryEngine.submitMessage()
    │  → yield SDKSystemMessage (init)
    │  → processUserInput()
    │  → for await (event of query({...})):
    │       ┌─ API 调用 (claude.ts → withRetry → stream SSE)
    │       ├─ 工具执行 (StreamingToolExecutor / runTools)
    │       │     └─ 需要权限? → control_request → SDK → canUseTool → control_response
    │       │     └─ Hook 触发? → control_request → SDK → hookCallback → control_response
    │       ├─ 自动压缩 (autoCompactIfNeeded)
    │       └─ 续行判定 (next_turn / completed / error)
    │  → yield SDKResultMessage
    ▼
stdout NDJSON → ProcessTransport.readMessages() → AsyncIterator<SDKMessage>
    │
    ▼
SDK 消费者收到消息流
    for await (const message of query({...})) {
      // assistant, user, tool_progress, result, ...
    }
```

---

## 十、设计哲学总结

| 维度 | 设计决策 |
|------|---------|
| **复用而非重写** | SDK 100% 复用 Claude Code 的 Agent 循环、工具系统、压缩、权限，零代码重复 |
| **进程隔离** | SDK 宿主和 CLI 是独立进程，通过 stdio 通信，崩溃不互相影响 |
| **协议驱动** | NDJSON + control protocol 是唯一的接口契约，允许 Python/TS/远程等多种宿主 |
| **渐进暴露** | 简单用例只需 `query(prompt, options)`，高级用例可用 hooks/canUseTool/agents/MCP |
| **版本一致** | SDK 包内嵌 CLI 二进制，确保 SDK 版本和 CLI 版本完全匹配 |
| **安全优先** | `bypassPermissions` 需显式 `allowDangerouslySkipPermissions`，子 agent 继承权限模式 |
