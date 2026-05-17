# MCP 系统深度分析

> 源码路径：`src/tools/MCPTool/`、`src/tools/ListMcpResourcesTool/`、`src/tools/ReadMcpResourceTool/`、`src/tools/McpAuthTool/`、`src/services/mcp/`

---

## 一、MCP 工具模板

### 1.1 MCPTool 基础模板

**文件**：`src/tools/MCPTool/MCPTool.ts`

MCPTool 是一个 **骨架工具**，所有关键方法在 `client.ts` 的 `fetchToolsForClient()` 中被覆盖：

```typescript
MCPTool = buildTool({
  isMcp: true,
  name: 'mcp',                    // 被覆盖为 mcp__<server>__<tool>
  inputSchema: z.object({}).passthrough(),  // 被 inputJSONSchema 取代
  call: async () => ({ data: '' }),         // 被覆盖为 MCP RPC 调用
  prompt: () => '',                         // 被覆盖为 MCP tool.description
  checkPermissions: () => ({ behavior: 'passthrough' }),
})
```

### 1.2 MCP 工具创建流程

**文件**：`src/services/mcp/client.ts` — `fetchToolsForClient()`

```
fetchToolsForClient(client)
    │
    ├─ client.client.request({ method: 'tools/list' })
    ├─ recursivelySanitizeUnicode()
    │
    └─ 对每个 MCP tool:
        ├─ name: buildMcpToolName(serverName, toolName)
        │       = mcp__<normalize(server)>__<normalize(tool)>
        ├─ mcpInfo: { serverName, toolName }
        ├─ isMcp: true
        ├─ searchHint: tool._meta['anthropic/searchHint']
        ├─ alwaysLoad: tool._meta['anthropic/alwaysLoad']
        ├─ isConcurrencySafe/isReadOnly: tool.annotations?.readOnlyHint
        ├─ isDestructive: tool.annotations?.destructiveHint
        ├─ isOpenWorld: tool.annotations?.openWorldHint
        ├─ inputJSONSchema: 直接使用 MCP 的 inputSchema（非 Zod）
        ├─ description/prompt: tool.description（截断 2048 字符）
        ├─ checkPermissions: { behavior: 'passthrough' }
        │
        └─ call(args, context, ...) →
            callMCPToolWithUrlElicitationRetry()
```

**工具名规范化**：`normalizeNameForMCP(name)` 将 `[^a-zA-Z0-9_-]` 替换为 `_`。claude.ai 服务器额外合并连续下划线并去除首尾下划线。

**过滤规则**：`isIncludedMcpTool()` 阻止所有 `mcp__ide__*` 工具，除了 `executeCode` 和 `getDiagnostics`。

---

## 二、MCP 传输协议

**文件**：`src/services/mcp/client.ts` — `connectToServer()`

### 2.1 协议矩阵

| 类型 | 传输层 | 认证 | 特殊处理 |
|------|--------|------|----------|
| `stdio` | `StdioClientTransport` | 无 | stderr 管道捕获（64 MB 上限）；`CLAUDE_CODE_SHELL_PREFIX` 包装 |
| `sse` | `SSEClientTransport` | `ClaudeAuthProvider` (OAuth) | 非流式请求有超时包装；SSE 流无超时 |
| `sse-ide` | `SSEClientTransport` | 无 | proxy dispatcher（如果配置） |
| `http` | `StreamableHTTPClientTransport` | `ClaudeAuthProvider` / Session Ingress JWT | CCR 代理 URL 检测 |
| `ws` | `WebSocketTransport` | Session Ingress JWT | Bun 原生 WebSocket 或 Node.js 回退 |
| `ws-ide` | `WebSocketTransport` | `X-Claude-Code-Ide-Authorization` | IDE 令牌 |
| `sdk` | 分离处理（`print.ts`） | — | 抛出异常 |
| `claudeai-proxy` | `StreamableHTTPClientTransport` | claude.ai OAuth Bearer | `createClaudeAiProxyFetch`，401 自动重试 |

### 2.2 特殊 stdio 服务器（进程内运行）

两类 MCP 服务器在进程内运行以避免额外子进程开销：

| 服务器 | 条件 | 传输 |
|--------|------|------|
| Chrome MCP | `isClaudeInChromeMCPServer` | `createLinkedTransportPair()` + `createClaudeForChromeMcpServer()` |
| Computer Use MCP | `isComputerUseMCPServer` + `CHICAGO_MCP` feature | `createComputerUseMcpServerForCli()` |

`InProcessTransport`（`createLinkedTransportPair()`）：双向链接传输对，`send()` 使用 `queueMicrotask` 防止调用栈深度问题。

### 2.3 连接并发控制

| 服务器类型 | 并发数 | 环境变量 |
|-----------|:------:|----------|
| 本地（stdio/sdk） | 3 | `MCP_SERVER_CONNECTION_BATCH_SIZE` |
| 远程（http/sse/claudeai-proxy） | 20 | `MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE` |

使用 `pMap`（p-map 库）调度，空槽立即释放（无批次边界等待）。

---

## 三、MCP 工具调用链

```
MCP tool.call(args, context)
    │
    ├─ emit mcp_progress { status: 'started' }
    │
    ├─ 重试循环（MAX_SESSION_RETRIES = 1 次额外尝试）
    │   │
    │   ├─ ensureConnectedClient(client)
    │   │   ├─ memoize 命中 → 返回缓存连接
    │   │   └─ onclose 后缓存已清 → 重新连接
    │   │
    │   ├─ callMCPToolWithUrlElicitationRetry()
    │   │   │
    │   │   ├─ callMCPTool()
    │   │   │   └─ client.client.callTool({ name, arguments })
    │   │   │       timeout: 100,000,000 ms（~27.8 小时）
    │   │   │
    │   │   └─ URL 引出请求？（elicitation/create）
    │   │       └─ OAuth 重定向 → 用户完成 → 重试调用
    │   │
    │   ├─ McpSessionExpiredError → 清缓存 → 继续循环
    │   └─ 其他错误 → TelemetrySafeError 包装
    │
    └─ emit mcp_progress { status: 'completed' | 'failed' }

返回: { data: mcpResult.content, mcpMeta?: { _meta, structuredContent } }
```

---

## 四、连接生命周期管理

### 4.1 错误处理（`client.onerror`）

```
client.onerror:
    │
    ├─ HTTP 404 + JSON-RPC -32001 → session 过期
    │   └─ closeTransportAndRejectPending('session expired')
    │       └─ client.close() → 拒绝所有挂起的 tool call Promise（McpError -32000）
    │
    ├─ HTTP/SSE/claudeai-proxy:
    │   ├─ "Maximum reconnection attempts" → 强制关闭
    │   └─ 连续终端错误（ECONNRESET, ETIMEDOUT, EPIPE, EHOSTUNREACH,
    │       ECONNREFUSED, body timeout, SSE disconnect）
    │       └─ 3 次连续 → 强制关闭
    │
    └─ 链到原始 onerror handler
```

### 4.2 关闭处理（`client.onclose`）

清除所有 memoize 缓存：
- `connectToServer.cache.delete(key)`
- `fetchToolsForClient.cache.delete(name)`
- `fetchResourcesForClient.cache.delete(name)`
- `fetchCommandsForClient.cache.delete(name)`

→ 下次工具调用触发 `ensureConnectedClient` 重新连接。

### 4.3 进程清理

注册到 `registerCleanup` 的清理函数：

| 类型 | 清理流程 |
|------|----------|
| 进程内 | close server + close client |
| stdio | SIGINT → 100ms 等待 → SIGTERM（400ms）→ SIGKILL，总超时 600ms |
| 所有类型 | `client.close()` |

### 4.4 重连逻辑

**文件**：`src/services/mcp/useManageMCPConnections.ts`

| 常量 | 值 |
|------|-----|
| `MAX_RECONNECT_ATTEMPTS` | 5 |
| `INITIAL_BACKOFF_MS` | 1000 |
| `MAX_BACKOFF_MS` | 30000 |

```
onclose 重连策略：
    ├─ sse/http/ws → 指数退避重连（最多 5 次）
    └─ stdio/sdk → 立即标记 failed（不重连）
```

**批量更新**：`updateServer()` 将更新加入 `pendingUpdatesRef`，启动 16ms 批量定时器。`flushPendingUpdates()` 原子性地应用所有排队的更新——按服务器名前缀替换 tools/commands，合并 resources。

**变更检测**：
- `tools/list_changed` → 清除 fetchTools 缓存，重新获取，调用 updateServer
- `prompts/list_changed` → 同上，清缓存 + 重新获取
- `resources/list_changed` → 同上

---

## 五、MCP OAuth 认证

**文件**：`src/services/mcp/auth.ts`

### 5.1 ClaudeAuthProvider

实现 `OAuthClientProvider` 接口：

| 方法 | 行为 |
|------|------|
| `getServerKey()` | SHA-256(`{type, url, headers}`) → `name\|<16 hex>` 隔离跨服务器凭据 |
| `tokens()` | 从 keychain 读取；过期前 5 分钟主动刷新；XAA 静默刷新 |
| `refreshAuthorization()` | 跨进程文件锁（`mcp-refresh-<key>.lock`），最多 3 次指数退避（1s, 2s, 4s） |

### 5.2 标准 OAuth 流程

`performMCPOAuthFlow()` — PKCE + 动态客户端注册：

```
1. 查找可用本地端口
2. 创建 ClaudeAuthProvider
3. sdkAuth()（redirect）→ 获取 auth URL
4. 启动本地 HTTP 服务器（127.0.0.1:<port>）等待回调
5. 等待回调（code + state）
6. 验证 state（CSRF 检查、XSS 消毒）
7. sdkAuth(code) → 换取 tokens
8. 保存 tokens 到安全存储
   超时: 5 分钟；支持 AbortSignal；可手动粘贴 URL
```

### 5.3 XAA 流程（Cross-App Access）

`performMCPXaaAuth()` — RFC 8693 Token Exchange：

```
1. 获取 IdP id_token（OIDC PKCE，按 issuer 缓存在 keychain）
2. 发现 IdP token endpoint
3. performCrossAppAccess()（token exchange）
4. 保存 tokens
```

### 5.4 Step-Up 认证

`wrapFetchWithStepUpDetection()` 包装 fetch，拦截 403 + `insufficient_scope`（WWW-Authenticate header），调用 `provider.markStepUpPending(scope)` 触发升级流程。

### 5.5 Token 撤销

`revokeServerTokens()`：RFC 7009，先撤 refresh_token 再撤 access_token，401 时回退 Bearer auth，best-effort 不抛异常。

### 5.6 Discovery State 持久化

`saveDiscoveryState()` 仅持久化 URL（不是完整 metadata blob），规避 macOS keychain 4096 字节行限制。

---

## 六、McpAuthTool — 认证伪工具

**文件**：`src/tools/McpAuthTool/McpAuthTool.ts`

当 MCP 服务器已安装但未认证时，`createMcpAuthTool(serverName, config)` 创建一个伪工具替代服务器的真实工具：

```
名称: mcp__<server>__authenticate
权限: { behavior: 'allow' }（自动允许）
```

调用行为按传输类型分：

| 类型 | 行为 |
|------|------|
| `claudeai-proxy` | 返回不支持消息，指引用户运行 /mcp |
| `stdio`/其他非 sse/http | 返回不支持消息 |
| `sse` / `http` | 启动 OAuth 流程（见下） |

**OAuth 流程**：

```
call()
    │
    ├─ performMCPOAuthFlow({ skipBrowserOpen: true, resolveAuthUrl })
    │   └─ 后台 Promise：OAuth 完成 → clearMcpAuthCache() → reconnectMcpServerImpl()
    │       → setAppState：前缀替换移除 authenticate 伪工具，注入真实工具
    │
    └─ Promise.race([authUrlPromise, oauthPromise])
        ├─ 获得 authUrl → 返回给模型（让模型告诉用户去浏览器完成认证）
        └─ OAuth 静默完成（XAA 缓存命中）→ 返回 "completed silently"
```

---

## 七、ListMcpResourcesTool

**文件**：`src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts`

```typescript
输入: { server?: string }  // 可选服务器名过滤
输出: Array<{ uri, name, mimeType?, description?, server }>
```

- `shouldDefer: true`，`isReadOnly: true`，`isConcurrencySafe: true`
- 遍历已连接 MCP 客户端，调用 `fetchResourcesForClient()`（LRU 缓存）
- 每个服务器的错误独立捕获，不影响其他服务器
- 仅在**第一个**有 resources capability 的服务器连接时创建（避免重复）

---

## 八、ReadMcpResourceTool

**文件**：`src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts`

```typescript
输入: { server: string, uri: string }
输出: { contents: Array<{ uri, mimeType?, text?, blobSavedTo? }> }
```

- `shouldDefer: true`，`isReadOnly: true`，`isConcurrencySafe: true`
- 通过 `ensureConnectedClient()` 确保连接
- 发送 `resources/read` MCP 请求
- **Blob 处理**：base64 解码 → `persistBinaryContent()` 保存到磁盘 → 返回文件路径引用（避免 base64 进入 context）
- 文本内容直接返回

---

## 九、MCP 配置

**文件**：`src/services/mcp/config.ts`

### 9.1 配置作用域（优先级从高到低）

| 作用域 | 来源 | 说明 |
|--------|------|------|
| enterprise | 托管文件（如存在则排他） | 企业策略 |
| local | `.claude/local-settings.json` | 本地覆盖 |
| project | `.mcp.json`（向上遍历至根） | 项目配置 |
| user | `~/.claude/settings.json` | 全局用户 |
| dynamic | CLI/plugin 运行时添加 | 动态 |
| claudeai-proxy | claude.ai 代理 | 最低优先级 |

### 9.2 环境变量展开

`expandEnvVars()` 展开 command/args/url/headers 中的 `${VAR}`。缺失变量产生警告。

### 9.3 策略控制

`isMcpServerAllowedByPolicy()` 检查 `allowedMcpServers`（名称/命令/URL）和 `deniedMcpServers`；拒绝列表优先。

### 9.4 去重

`getMcpServerSignature()` 生成签名：
- stdio: `stdio:<json_cmd>`
- url-based: `url:<unwrapped_url>`

`unwrapCcrProxyUrl()` 剥离 CCR 代理包装以匹配原始 vendor URL。

---

## 十、SdkControlTransport

**文件**：`src/services/mcp/SdkControlTransport.ts`

用于 SDK 模式下 CLI 与宿主进程托管的 MCP 服务器通信：

```
CLI MCP Client ↔ SdkControlClientTransport ↔ stdout/stdin 控制消息 ↔ SdkControlServerTransport ↔ SDK-hosted MCP Server
```

`send()` 通过 `sendMcpMessage(serverName, message)` 回调传递消息，并关联请求/响应对等待响应。

---

## 十一、MCP 辅助模块

### 11.1 normalization.ts — 名称消毒（零依赖）

**文件**：`src/services/mcp/normalization.ts`

整个 MCP 名称规范化链的**最底层**，有意设计为零依赖以避免循环导入。

```typescript
const CLAUDEAI_SERVER_PREFIX = 'claude.ai '  // 模块私有

export function normalizeNameForMCP(name: string): string
```

**逻辑**：
1. 将所有非 `[a-zA-Z0-9_-]` 字符替换为 `_`（满足 API 约束 `^[a-zA-Z0-9_-]{1,64}$`）
2. 对 `"claude.ai "` 开头的名称额外处理：
   - 合并连续下划线（`_+` → `_`）
   - 去除首尾下划线
   - 防止多余 `_` 破坏 `__` 分隔符

### 11.2 mcpStringUtils.ts — 名称解析与构建

**文件**：`src/services/mcp/mcpStringUtils.ts`

仅依赖 `normalization.ts`，保持轻量以便权限校验代码安全导入。被 13+ 个外部文件引用（permissions.ts、toolExecution.ts、toolHooks.ts 等）。

| 函数 | 说明 |
|------|------|
| `buildMcpToolName(server, tool)` | 构建 `mcp__<norm(server)>__<norm(tool)>` |
| `mcpInfoFromString(str)` | 解析工具名 → `{ serverName, toolName }` 或 null |
| `getMcpPrefix(server)` | 返回 `mcp__<norm(server)>__` 前缀 |
| `getToolNameForPermissionCheck(tool)` | MCP 工具返回全限定名，内置工具返回 `tool.name` |
| `getMcpDisplayName(fullName, server)` | 从全名中去除服务器前缀，返回工具显示名 |
| `extractMcpToolDisplayName(userFacingName)` | 从 `"server - Tool Name (MCP)"` 提取 `"Tool Name"` |

**已知限制**：如果服务器名本身包含 `__`，`mcpInfoFromString` 会错误分割段。

### 11.3 utils.ts — 高级工具函数

**文件**：`src/services/mcp/utils.ts`

依赖最重，导入 config、settings、crypto、path 等。提供集合操作、状态管理和策略检查。

#### 过滤与排除

| 函数 | 说明 |
|------|------|
| `filterToolsByServer(tools, server)` | 按服务器名筛选工具 |
| `filterCommandsByServer(commands, server)` | 按服务器名筛选命令 |
| `filterMcpPromptsByServer(commands, server)` | 同上，额外排除 MCP skill 命令 |
| `filterResourcesByServer(resources, server)` | 按服务器名筛选资源 |
| `excludeToolsByServer(tools, server)` | filter 的反向操作 |
| `excludeCommandsByServer(commands, server)` | 同上 |
| `excludeResourcesByServer(resources, server)` | 删除资源 map 中的指定服务器 |

#### 配置变更检测

| 函数 | 说明 |
|------|------|
| `hashMcpConfig(config)` | SHA-256 前 16 hex，key 排序确定性输出，strip scope |
| `excludeStalePluginClients(mcp, configs)` | 检测过期连接（动态服务器被移除 或 config hash 变化），返回清理后的状态 + stale 列表 |

#### 类型判断

| 函数 | 说明 |
|------|------|
| `isMcpTool(tool)` | `name.startsWith('mcp__')` 或 `tool.isMcp === true` |
| `isMcpCommand(command)` | 同上 |
| `isToolFromMcpServer(toolName, server)` | 解析名称并比较 server |

#### 安全与策略

```typescript
getProjectMcpServerStatus(serverName): 'approved' | 'rejected' | 'pending'
```

查询持久化设置判断项目级 MCP 服务器是否已被用户批准。在 bypass-permissions 模式或非交互会话中自动批准。**安全注释**：明确阻止 projectSettings 自动接受 bypass 对话框（防止恶意仓库通过 `.mcp.json` 实现 RCE）。

#### Agent MCP 提取

```typescript
extractAgentMcpServers(agents): AgentMcpServerInfo[]
```

从 Agent 定义中收集内联 MCP 服务器配置，去重（按 serverName 合并 sourceAgents），仅支持 stdio/sse/http/ws 四种传输，静默丢弃内部类型（sdk/claudeai-proxy/sse-ide/ws-ide）。

### 11.4 依赖层次

```
normalization.ts          （零依赖——循环导入安全）
       ↑
mcpStringUtils.ts         （仅依赖 normalization——轻量，权限代码可安全导入）
       ↑
utils.ts                  （依赖两者 + config/settings/crypto——功能完整，依赖较重）
```

三层严格分层设计，确保 `mcpStringUtils.ts`（及其传递依赖 `normalization.ts`）可被安全敏感的权限校验代码导入，不会引入 `utils.ts` 的完整依赖树。

---

## 十二、配置项速查

### 12.1 环境变量

| 变量 | 说明 |
|------|------|
| `MCP_SERVER_CONNECTION_BATCH_SIZE` | 本地服务器并发连接数（默认 3） |
| `MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE` | 远程服务器并发连接数（默认 20） |
| `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` | MCP 工具名不加前缀 |
| `CLAUDE_CODE_SHELL_PREFIX` | 包装 stdio 命令的 shell |

### 12.2 Feature Flags

| Flag | 说明 |
|------|------|
| `CHICAGO_MCP` | 启用 Computer Use MCP 进程内运行 |

### 12.3 关键超时

| 超时 | 值 | 说明 |
|------|-----|------|
| MCP 工具调用超时 | ~27.8 小时 | `DEFAULT_MCP_TOOL_TIMEOUT_MS = 100,000,000` |
| OAuth 流程超时 | 5 分钟 | `performMCPOAuthFlow` |
| MCP 连接超时 | `getConnectionTimeoutMs()` | 可配置 |
| 初始重连退避 | 1 秒 | `INITIAL_BACKOFF_MS` |
| 最大重连退避 | 30 秒 | `MAX_BACKOFF_MS` |
| 进程清理总超时 | 600 毫秒 | SIGINT → SIGTERM → SIGKILL |
| Token 刷新退避 | 1s, 2s, 4s | 最多 3 次指数退避 |
