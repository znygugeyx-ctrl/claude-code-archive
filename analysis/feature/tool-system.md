# Claude Code 工具系统分析

> 核心源码路径：`src/Tool.ts`、`src/tools.ts`、`src/tools/`、`src/services/tools/`

---

## 一、总体架构

Claude Code 的工具系统是一套完整的「定义 → 注册 → 发现 → 鉴权 → 执行 → 结果处理」管线，支持内置工具、MCP 外部工具、延迟加载（Deferred Tools）、Hook 拦截等机制。模型通过 `tool_use` 内容块请求调用工具，系统解析后走权限检查 → 钩子 → 执行 → 结果回注的完整流程。

---

## 二、工具定义与注册

### 2.1 Tool 接口

**文件**：`src/Tool.ts`

`Tool<Input, Output, P>` 是泛型接口，核心成员：

| 成员 | 说明 |
|------|------|
| `name` (readonly) | 主标识符，用于查找和 API 分发 |
| `aliases?` | 向后兼容的旧名称 |
| `inputSchema` | Zod schema，执行前用 `safeParse()` 校验输入 |
| `inputJSONSchema?` | 直接 JSON Schema（MCP 工具使用） |
| `description()` | 异步；返回给模型的工具描述 |
| `prompt()` | 异步；返回发送给 API 的完整提示文本 |
| `call()` | 主执行方法，接收解析后的参数、`ToolUseContext`、权限函数等 |
| `checkPermissions()` | 工具特定的权限逻辑 |
| `validateInput()` | 权限检查前的输入校验 |
| `isEnabled()` | 是否启用 |
| `isReadOnly()` | 是否只读（影响权限判定） |
| `isConcurrencySafe()` | 是否可并发执行 |
| `isDestructive()` | 是否为破坏性操作 |
| `shouldDefer?` | 是否延迟加载（通过 ToolSearch 发现） |
| `alwaysLoad?` | 覆盖 defer（MCP 的 `anthropic/alwaysLoad`） |
| `isMcp?` | 是否来自 MCP 服务器 |
| `searchHint?` | ToolSearch 关键词匹配的提示短语 |
| `maxResultSizeChars` | 结果超此阈值时持久化到磁盘 |
| `mapToolResultToToolResultBlockParam()` | 将输出转换为 API `ToolResultBlockParam` |
| `backfillObservableInput()` | 为 hooks/SDK 补填可观察输入（不影响 call） |
| `preparePermissionMatcher()` | 构建 hook `if` 条件匹配器 |
| `interruptBehavior?()` | 用户中断时的行为：`'cancel'` 或 `'block'` |

### 2.2 `buildTool()` 工厂

**文件**：`src/Tool.ts`（约 line 783）

所有工具通过 `buildTool(def)` 构造，应用默认值：

```typescript
isEnabled       → true
isConcurrencySafe → false
isReadOnly      → false
isDestructive   → false
checkPermissions → { behavior: 'allow' }  // 直通到通用权限系统
```

### 2.3 工具注册表

**文件**：`src/tools.ts`

三个核心函数构成注册链：

```
getAllBaseTools()
    ↓ 根据 feature flag / 环境变量条件包含
getTools(permissionContext)
    ↓ deny 规则 + isEnabled + REPL/Simple 模式过滤
assembleToolPool(permissionContext, mcpTools)
    ↓ 合并内置 + MCP，去重（内置优先），排序（缓存稳定性）
```

条件包含的依据：
- `feature('...')` 编译时特性标志（PROACTIVE、KAIROS、COORDINATOR_MODE 等）
- `process.env.USER_TYPE === 'ant'`（Anthropic 内部工具）
- 运行时检查如 `isWorktreeModeEnabled()`、`isAgentSwarmsEnabled()`

---

## 三、内置工具清单

### 核心工具

| 工具 | 目录 | 用途 | 并发安全 | 只读 |
|------|------|------|:--------:|:----:|
| **BashTool** | `BashTool/` | 执行 shell 命令 | ✗ | ✗ |
| **FileReadTool** | `FileReadTool/` | 读取文件（文本/图片/PDF/Notebook） | ✓ | ✓ |
| **FileEditTool** | `FileEditTool/` | 编辑文件（字符串替换） | ✗ | ✗ |
| **FileWriteTool** | `FileWriteTool/` | 创建/覆写文件 | ✗ | ✗ |
| **GlobTool** | `GlobTool/` | 文件路径 glob 匹配 | ✓ | ✓ |
| **GrepTool** | `GrepTool/` | 文件内容搜索（ripgrep） | ✓ | ✓ |
| **NotebookEditTool** | `NotebookEditTool/` | 编辑 Jupyter Notebook | ✗ | ✗ |

### 网络工具

| 工具 | 用途 |
|------|------|
| **WebFetchTool** | 抓取 URL 内容 |
| **WebSearchTool** | 网络搜索 |
| **WebBrowserTool** | 浏览器交互 |

### Agent 与任务工具

| 工具 | 用途 |
|------|------|
| **AgentTool** | 创建子 agent 对话（explore/plan/verify/general） |
| **TaskCreateTool** | 创建任务（todo v2） |
| **TaskGetTool** | 查询任务详情 |
| **TaskUpdateTool** | 更新任务状态 |
| **TaskListTool** | 列出任务 |
| **TaskOutputTool** | 后台任务输出 |
| **TaskStopTool** | 停止运行中的后台任务 |

### 交互与计划工具

| 工具 | 用途 |
|------|------|
| **AskUserQuestionTool** | 向用户提问 |
| **EnterPlanModeTool** | 进入计划模式 |
| **ExitPlanModeV2Tool** | 退出计划模式 |
| **VerifyPlanExecutionTool** | 验证计划执行结果 |
| **SkillTool** | 执行已加载的 skill |

### 工具发现与 MCP

| 工具 | 用途 |
|------|------|
| **ToolSearchTool** | 按关键词/名称发现延迟加载的工具 |
| **ListMcpResourcesTool** | 列出 MCP 服务器资源 |
| **ReadMcpResourceTool** | 读取 MCP 服务器资源 |
| **McpAuthTool** | MCP OAuth 认证流程 |

### Worktree 与协作

| 工具 | 用途 |
|------|------|
| **EnterWorktreeTool** | 进入 git worktree 隔离环境 |
| **ExitWorktreeTool** | 退出 git worktree |
| **SendMessageTool** | 向同伴/团队成员发消息 |
| **ListPeersTool** | 列出 UDS inbox 同伴 |
| **TeamCreateTool** | 创建 swarm 团队 |
| **TeamDeleteTool** | 删除 swarm 团队 |

### 自动化与调度（需特性标志）

| 工具 | 用途 |
|------|------|
| **SleepTool** | 主动休眠（Proactive 模式） |
| **CronCreate/Delete/ListTool** | Cron 定时任务 |
| **RemoteTriggerTool** | 远程 agent 触发 |
| **MonitorTool** | 监控 |
| **PushNotificationTool** | 推送通知 |
| **SubscribePRTool** | 订阅 PR webhook |
| **WorkflowTool** | 执行 workflow 脚本 |
| **BriefTool** | Kairos 简报通信 |

### 其他

| 工具 | 用途 |
|------|------|
| **LSPTool** | Language Server Protocol 操作 |
| **REPLTool** | VM 沙盒内执行（ant-only，包装原始工具） |
| **ConfigTool** | 修改设置（ant-only） |
| **SnipTool** | 历史裁剪 |
| **TerminalCaptureTool** | 终端面板截图 |
| **SendUserFileTool** | 向用户发送文件 |
| **PowerShellTool** | PowerShell 执行（Windows） |

---

## 四、工具执行流程

### 4.1 整体管线

```
模型返回 tool_use 块
    ↓
┌─ StreamingToolExecutor ──────────────────────────────┐
│  流式接收 tool_use 块，维护 TrackedTool 队列           │
│  状态: queued → executing → completed → yielded       │
│  并发安全工具并行执行，非并发工具独占执行                  │
└──────────────────────────────────────────────────────┘
    ↓ 或
┌─ runTools() ─────────────────────────────────────────┐
│  toolOrchestration.ts                                 │
│  按 isConcurrencySafe 分区                             │
│  并发批次 → runToolsConcurrently (最多 10 个)           │
│  串行批次 → runToolsSerially                           │
└──────────────────────────────────────────────────────┘
    ↓
┌─ runToolUse() ── 单工具分发 ─────────────────────────┐
│  1. findToolByName()（含别名回退）                      │
│  2. 检查 abort signal                                 │
│  3. → checkPermissionsAndCallTool()                   │
└──────────────────────────────────────────────────────┘
```

### 4.2 `checkPermissionsAndCallTool()` —— 核心执行管线

**文件**：`src/services/tools/toolExecution.ts`（约 line 599）

```
1. Zod 输入校验           tool.inputSchema.safeParse(input)
       ↓ 失败 → InputValidationError（含 deferred tool 提示）
2. 工具特定校验           tool.validateInput()
       ↓
3. 推测性分类器           Bash 工具并行启动 allow 分类器
       ↓
4. 输入回填              tool.backfillObservableInput()（克隆）
       ↓
5. PreToolUse 钩子       runPreToolUseHooks()
       ↓ 可返回: hookPermissionResult / hookUpdatedInput / stopReason
6. 权限检查              resolveHookPermissionDecision() + canUseTool()
       ↓ deny → 返回错误 + executePermissionDeniedHooks()
       ↓ allow ↓
7. 执行工具              tool.call(callInput, context, canUseTool, msg, onProgress)
       ↓
8. 处理结果              processToolResultBlock()
       ↓ 超大结果 → 持久化到磁盘
9. PostToolUse 钩子      runPostToolUseHooks()（可修改 MCP 输出）
       ↓
10. 返回 UserMessage     tool_result 内容块
```

### 4.3 并发控制

- **最大并发数**：`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`，默认 10
- **并发安全工具**（`isConcurrencySafe: true`）：GlobTool、GrepTool、FileReadTool 等只读工具
- **非并发安全工具**：BashTool、FileEditTool、FileWriteTool 等写操作工具
- StreamingToolExecutor 维护一个状态队列，确保非并发工具独占运行

---

## 五、权限系统

### 5.1 权限模式

**文件**：`src/types/permissions.ts`

| 模式 | 行为 |
|------|------|
| `'default'` | 非安全操作询问用户 |
| `'bypassPermissions'` | 自动允许一切（安全检查除外） |
| `'acceptEdits'` | 自动允许文件编辑，其余询问 |
| `'plan'` | 计划模式（只读） |
| `'dontAsk'` | 把"询问"转为"拒绝" |
| `'auto'` | AI 分类器决定（`TRANSCRIPT_CLASSIFIER` 特性标志） |
| `'bubble'` | 权限向上冒泡 |

### 5.2 权限规则

三类规则集，存在于 `ToolPermissionContext`：

- **`alwaysAllowRules`** — 自动允许特定工具/模式
- **`alwaysDenyRules`** — 阻止特定工具/模式
- **`alwaysAskRules`** — 始终询问特定工具/模式

规则来源（按优先级）：
`policySettings` > `userSettings` > `projectSettings` > `localSettings` > `flagSettings` > `cliArg` > `command` > `session`

**内容模式匹配**：规则支持内容级匹配，如 `Bash(git *)` 匹配以 `git` 开头的 Bash 命令，通过 `tool.preparePermissionMatcher()` 构建匹配器。

### 5.3 权限检查流程

**文件**：`src/utils/permissions/permissions.ts`

```
hasPermissionsToUseTool()
    │
    ├─ Step 1a: 全局 deny 规则检查
    ├─ Step 1b: 全局 ask 规则检查
    ├─ Step 1c: tool.checkPermissions()（工具特定逻辑）
    │     例：Bash 解析命令、检查前缀、沙盒判定
    ├─ Step 1d: 工具拒绝 → deny
    ├─ Step 1e: 工具要求交互 → 尊重
    ├─ Step 1f: 工具的内容级 ask 规则优先于 bypass
    ├─ Step 1g: 安全检查（.git/、.claude/、shell 配置文件）→ bypass 免疫
    │
    ├─ Step 2a: 模式级 bypass（bypassPermissions 等）
    ├─ Step 2b: acceptEdits 模式 → 文件操作允许，其余询问
    │
    ├─ Step 3: 内容级 allow 规则（如 Bash(git *)）
    ├─ Step 4: 工具为只读 → 允许
    └─ Step 5: 兜底 → 询问用户
```

### 5.4 用户审批流程

**文件**：`src/hooks/useCanUseTool.tsx`

```
useCanUseTool()
    ├─ allow → 直接通过
    ├─ deny → 拒绝，记录 auto-mode 统计
    └─ ask →
        ├─ Coordinator 模式 → handleCoordinatorPermission（自动化检查）
        ├─ Swarm worker → handleSwarmWorkerPermission
        ├─ 推测性 Bash 分类器 → 检查并行分类结果
        └─ 交互模式 → handleInteractivePermission（弹出权限对话框）
```

---

## 六、延迟工具与 ToolSearch

### 6.1 延迟判定逻辑

**文件**：`src/tools/ToolSearchTool/prompt.ts`

`isDeferredTool(tool)` 判定规则：

| 条件 | 结果 |
|------|------|
| `tool.alwaysLoad === true` | **永不**延迟 |
| `tool.isMcp === true` | **始终**延迟 |
| `tool.shouldDefer === true` | 延迟 |
| ToolSearchTool 自身 | 豁免 |

### 6.2 ToolSearch 模式

**文件**：`src/utils/toolSearch.ts`

| 模式 | 行为 | 触发方式 |
|------|------|----------|
| `tst` | 始终延迟 | 默认 |
| `tst-auto` | 工具 token 超阈值时延迟（默认 10% 上下文窗口） | `ENABLE_TOOL_SEARCH=auto` |
| `standard` | 不延迟 | `ENABLE_TOOL_SEARCH=false` |

### 6.3 ToolSearchTool 工作方式

**文件**：`src/tools/ToolSearchTool/ToolSearchTool.ts`

两种查询形式：

- **`select:Name1,Name2`** — 按名称直接选择工具
- **关键词搜索** — 按 CamelCase 拆分、MCP `__` 拆分、`searchHint` 和描述文本评分

返回 `tool_reference` 内容块，API 据此注入完整工具 schema。

### 6.4 API 集成

**文件**：`src/services/api/claude.ts`

- 延迟工具发送时携带 `deferLoading: true`
- 仅被"发现"过的延迟工具（历史中出现过 `tool_reference` 块）才被包含在后续 API 调用中
- 需要 `advanced-tool-use` beta header
- 延迟工具名通过 `<system-reminder>` 消息公告给模型

---

## 七、MCP 工具集成

### 7.1 MCP 工具创建

**文件**：`src/services/mcp/client.ts`

MCP 工具从 MCP 服务器的 `tools/list` 响应创建，每个工具：

- 基于 `MCPTool` 模板（`src/tools/MCPTool/MCPTool.ts`）扩展
- 命名：`mcp__<serverName>__<toolName>`（SDK 模式下无前缀）
- 携带 `mcpInfo: { serverName, toolName }` 用于权限匹配
- 使用 `inputJSONSchema`（直接来自 MCP，非 Zod）
- `isMcp: true`，`alwaysLoad` 来自 `_meta['anthropic/alwaysLoad']`
- `call()` 调用 `callMCPToolWithUrlElicitationRetry()` 与 MCP 服务器通信

### 7.2 支持的传输协议

| 协议 | 说明 |
|------|------|
| `stdio` | 标准输入输出 |
| `sse` | Server-Sent Events |
| `http` | StreamableHTTP |
| `ws` | WebSocket |
| `sdk` | 程序化 SDK |
| IDE 集成 | SSE/WS（VS Code、JetBrains） |
| `claudeai-proxy` | Claude.ai 代理 |

### 7.3 连接管理

**文件**：`src/services/mcp/MCPConnectionManager.tsx`

管理 MCP 服务器连接的生命周期：连接、重连、工具刷新。通过 `getMcpToolsCommandsAndResources()` 组装 MCP 工具列表。

---

## 八、工具钩子（Hooks）

### 8.1 工具相关的 Hook 事件

**文件**：`src/types/hooks.ts`

| 事件 | 触发时机 | 可执行操作 |
|------|----------|-----------|
| `PreToolUse` | 工具执行前 | 批准/阻止/修改输入/注入上下文/阻止继续 |
| `PostToolUse` | 工具执行后 | 注入上下文/阻止/更新 MCP 输出 |
| `PostToolUseFailure` | 工具执行失败后 | 自定义错误处理 |
| `PermissionRequest` | 权限即将被询问时 | 编程式允许/拒绝 |
| `PermissionDenied` | 权限被拒绝后 | 信号重试 |

### 8.2 Hook 类型

| 类型 | 说明 |
|------|------|
| `command` | Shell 命令（stdin 接收 JSON，stdout 输出 JSON） |
| `prompt` | LLM 提示词（Claude 评估） |
| `agent` | Agent 钩子 |
| `http` | HTTP 端点 |
| `function` | 进程内函数（SDK 编程模式） |

### 8.3 Hook 配置

在 `settings.json` 中配置：

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(git *)",     // 工具名 + 内容匹配
        "command": "my-hook-script",
        "timeout": 5000,
        "shell": "bash"
      }
    ]
  }
}
```

配置来源（按优先级）：`policySettings` > `userSettings` > `projectSettings` > `localSettings` > `pluginHook` > `sessionHook` > `builtinHook`

### 8.4 Hook 响应 Schema

```typescript
{
  continue: boolean,        // 是否继续
  suppressOutput: boolean,  // 隐藏 stdout
  stopReason: string,       // continue=false 时的消息
  decision: 'approve' | 'block',
  reason: string,           // 解释
  hookSpecificOutput: {     // 事件特定输出
    // PreToolUse:
    permissionDecision?: 'allow' | 'deny' | 'ask',
    updatedInput?: object,
    additionalContext?: string
  }
}
```

支持异步响应：`{ async: true, asyncTimeout?: number }`

---

## 九、工具呈现给模型的方式

### 9.1 Schema 生成

**文件**：`src/utils/api.ts`

`toolToAPISchema(tool, options)` 构建 API 工具定义：

1. 从 `tool.inputJSONSchema` 或 `zodToJsonSchema(tool.inputSchema)` 生成 `input_schema`
2. 从 `tool.prompt()` 获取 `description`（包含权限上下文、可用工具/agent）
3. 可选 `strict: true`（需特性标志 + 模型支持）
4. 可选 `eager_input_streaming`（细粒度流式）
5. 延迟工具添加 `defer_loading: true`
6. 基础 schema 按 session 缓存，保持 prompt cache 稳定

### 9.2 API 调用时的工具过滤

- 延迟工具仅在被 `tool_reference` 块"发现"后才包含
- ToolSearchTool 在工具搜索激活时始终包含
- 工具 schema 排序以保证缓存稳定性（内置优先，MCP 其次）

### 9.3 延迟工具公告

延迟工具名通过 `<system-reminder>` 附件或 `<available-deferred-tools>` 块注入用户消息，使模型知道可通过 ToolSearch 发现哪些工具。

---

## 十、工具结果处理

### 10.1 结果加工

**文件**：`src/utils/toolResultStorage.ts`

`processToolResultBlock(tool, result, toolUseID)`：

1. 调用 `tool.mapToolResultToToolResultBlockParam()` 转换为 API 格式
2. 检查结果大小是否超过 `getPersistenceThreshold(tool.name, tool.maxResultSizeChars)`
3. 超阈值时持久化到 `~/.claude/sessions/<id>/tool-results/<toolUseId>.txt`
4. 返回 `<persisted-output>` 包装，含预览（前 2000 字节）和文件路径

### 10.2 大结果持久化

部分工具设置 `maxResultSizeChars = Infinity`（如 FileReadTool 自行限制大小），其余工具超阈值时自动持久化。

### 10.3 ContentReplacementState

**文件**：`src/utils/toolResultStorage.ts`

管理每条消息的 token 预算，旧工具结果可被替换为 `[Old tool result content cleared]` 以节省上下文空间（与 Microcompact 配合使用）。

### 10.4 渲染方法

每个工具定义自己的渲染方法：

| 方法 | 用途 |
|------|------|
| `renderToolResultMessage()` | UI 中显示工具结果 |
| `renderToolUseMessage()` | 显示工具调用 |
| `renderToolUseProgressMessage()` | 执行过程中的进度 |
| `extractSearchText()` | 对话搜索索引 |
| `isResultTruncated()` | 控制 UI 中"点击展开" |

---

## 十一、配置项速查

### 环境变量

| 变量 | 说明 |
|------|------|
| `ENABLE_TOOL_SEARCH` | `true`/`false`/`auto`/`auto:N` — 工具搜索模式 |
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | 最大并行执行数（默认 10） |
| `CLAUDE_CODE_SIMPLE` | 限制为 Bash、Read、Edit 三个工具 |
| `ENABLE_LSP_TOOL` | 启用 LSP 工具 |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 禁用工具搜索 beta |
| `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` | MCP 工具使用无前缀名 |

### Settings 配置

权限规则在多层级 `settings.json` 中配置：

| 层级 | 路径 |
|------|------|
| 用户 | `~/.claude/settings.json` |
| 项目 | `.claude/settings.json` |
| 本地 | `.claude/local-settings.json` |
| 策略 | 企业管理策略 |

Hook 配置在 settings 的 `hooks` 键下，按事件名组织。

### Agent 受限工具

**文件**：`src/constants/tools.ts`

| 列表 | 说明 |
|------|------|
| `ALL_AGENT_DISALLOWED_TOOLS` | 子 agent 不可用的工具（TaskOutput、PlanMode、AskUser、TaskStop、Workflow） |
| `ASYNC_AGENT_ALLOWED_TOOLS` | 异步/后台 agent 的受限工具集 |
| `COORDINATOR_MODE_ALLOWED_TOOLS` | Coordinator 模式可用工具 |

---

## 十二、数据流总览

```
模型响应（含 tool_use 块）
    ↓
StreamingToolExecutor / runTools()
    ↓
findToolByName() ── 查找工具（含别名回退）
    ↓
inputSchema.safeParse() ── Zod 校验输入
    ↓
validateInput() ── 工具特定校验
    ↓
backfillObservableInput() ── 为 hook 补填可观察输入
    ↓
runPreToolUseHooks() ── 前置钩子（可拦截/修改/注入）
    ↓
resolveHookPermissionDecision() + canUseTool()
    ├─ deny → 返回错误 + PermissionDenied hooks
    └─ allow ↓
tool.call() ── 执行工具
    ↓
processToolResultBlock() ── 结果处理（可持久化）
    ↓
runPostToolUseHooks() ── 后置钩子（可修改输出）
    ↓
返回 UserMessage（tool_result 内容块）→ 加入对话历史 → 下一轮 API 调用
```
