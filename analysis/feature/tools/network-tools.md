# 网络工具深度分析

> 源码路径：`src/tools/WebFetchTool/`、`src/tools/WebSearchTool/`、`src/tools/WebBrowserTool/`

---

## 一、总览

Claude Code 有三个网络工具，架构差异很大：

| 工具 | 架构模式 | 实现状态 |
|------|----------|----------|
| **WebFetchTool** | 客户端直接 HTTP GET + Haiku 二次模型处理 | ✅ 完整 |
| **WebSearchTool** | 委托 Anthropic API 服务端搜索（`web_search_20250305`） | ✅ 完整 |
| **WebBrowserTool** | Anthropic 内部功能，feature-flagged（codename "bagel"） | ❌ Stub |

共同特征：

```
isReadOnly: true
isConcurrencySafe: true
shouldDefer: true
maxResultSizeChars: 100,000
```

---

## 二、WebFetchTool — URL 内容抓取

### 2.1 文件清单

| 文件 | 职责 |
|------|------|
| `WebFetchTool.ts` | 工具定义、权限检查、call() 入口 |
| `utils.ts` | 核心抓取逻辑、缓存、域名检查、HTML→Markdown |
| `prompt.ts` | 工具名/描述常量 + 二次模型 prompt 模板 |
| `preapproved.ts` | 预批准域名列表（~80 个技术文档站） |
| `UI.tsx` | 终端渲染 |

### 2.2 输入/输出 Schema

```typescript
// 输入
z.strictObject({
  url: z.string().url(),
  prompt: z.string(),           // 对内容的提取指令
})

// 输出
z.object({
  bytes: z.number(),            // 原始内容大小
  code: z.number(),             // HTTP 状态码
  codeText: z.string(),         // HTTP 状态文本
  result: z.string(),           // Haiku 处理后的结果
  durationMs: z.number(),       // 总耗时
  url: z.string(),              // 请求的 URL
})
```

### 2.3 执行流程

```
call(url, prompt)
    │
    ├─ 1. getURLMarkdownContent(url, abortController)
    │     │
    │     ├─ validateURL()
    │     │   ├─ 长度 ≤ 2000 字符
    │     │   ├─ 无 username/password
    │     │   ├─ 主机名至少两段（排除内网单标签域名）
    │     │   └─ 可解析
    │     │
    │     ├─ LRU 缓存查找（URL_CACHE，15 分钟 TTL）
    │     │   └─ 命中 → 直接返回
    │     │
    │     ├─ http: → https: 协议升级
    │     │
    │     ├─ 域名阻止列表预检（可选）
    │     │   ├─ 先查 DOMAIN_CHECK_CACHE（5 分钟 TTL，仅缓存 allowed）
    │     │   ├─ GET api.anthropic.com/api/web/domain_info?domain=<host>
    │     │   ├─ can_fetch: true → 允许，缓存
    │     │   ├─ can_fetch: false → DomainBlockedError
    │     │   └─ 请求失败 → DomainCheckFailedError（企业安全降级）
    │     │
    │     ├─ axios.get() + 手动重定向处理
    │     │   ├─ maxRedirects: 0（禁用 axios 自动跟随）
    │     │   ├─ 最多 10 次跳转（MAX_REDIRECTS）
    │     │   ├─ 仅允许同主机重定向（±www. 前缀）
    │     │   ├─ 跨主机重定向 → 返回 RedirectInfo 让模型重新调用
    │     │   └─ 403 + x-proxy-error: blocked-by-allowlist → EgressBlockedError
    │     │
    │     ├─ 二进制内容检测
    │     │   └─ isBinaryContentType → persistBinaryContent() 保存到磁盘
    │     │
    │     ├─ HTML → Markdown（turndown 库，懒加载单例）
    │     │
    │     └─ 存入 URL_CACHE（size = 内容字节数）
    │
    ├─ 2. 跨主机重定向？→ 返回 REDIRECT DETECTED 消息
    │
    ├─ 3. 预批准域 + text/markdown + 长度 < 100K？
    │     └─ 是 → 直接返回原始 markdown（跳过 Haiku）
    │
    ├─ 4. applyPromptToMarkdown()
    │     ├─ 截断至 100,000 字符
    │     ├─ 构建二次模型 prompt（版权策略因域名而异）
    │     └─ queryHaiku() → 调用 Anthropic 小模型
    │
    └─ 5. 如有 persistedPath → 追加二进制文件路径提示
```

### 2.4 安全与版权双重 Prompt 策略

`makeSecondaryModelPrompt()` 根据域名是否预批准，生成不同的指令：

| 条件 | Prompt 策略 |
|------|-------------|
| 预批准域 | 宽松：`"Provide a concise response... Include relevant details, code examples, and documentation excerpts as needed."` |
| 非预批准域 | 严格：引用上限 125 字符、必须用引号标注精确引用、禁止歌词复现 |

### 2.5 预批准域名机制

**文件**：`preapproved.ts`

~80 个技术文档站点，分两类存储：

```typescript
// 纯主机名 → O(1) Set.has() 查找
HOSTNAME_ONLY: Set<string>   // "docs.python.org", "react.dev", ...

// 路径限定条目 → 前缀匹配 + 路径段边界保护
PATH_PREFIXES: Map<string, string[]>   // "github.com" → ["/anthropics"]
```

路径段边界保护防止路径前缀欺骗：

```typescript
// "/anthropics" 匹配 "/anthropics" 和 "/anthropics/claude-code"
// 但不匹配 "/anthropics-evil/malware"
if (pathname === p || pathname.startsWith(p + '/')) return true
```

**安全警告**（源码注释）：预批准列表**仅用于 WebFetch GET 请求**，sandbox 网络限制不继承此列表。部分域名（huggingface.co、kaggle.com、nuget.org）支持上传，若允许 POST 等写操作可构成数据外泄通道。

### 2.6 权限模型

```
checkPermissions(input)
    │
    ├─ 1. 解析 URL → 检查预批准列表 → allow（绕过规则查找）
    │
    ├─ 2. 构建 ruleContent = "domain:<hostname>"
    │
    ├─ 3. deny 规则 → deny
    ├─ 4. ask 规则 → ask（附 localSettings 添加建议）
    ├─ 5. allow 规则 → allow
    │
    └─ 6. 兜底 → ask（附 localSettings 添加建议）
```

权限规则使用 `domain:hostname` 格式（非 URL），支持通配符 `domain:*.google.com`。规则校验器（`toolValidationConfig.ts`）会拒绝 `https://example.com` 格式并提示正确写法。

### 2.7 缓存架构

| 缓存 | Key | 策略 | TTL | 容量 |
|------|-----|------|-----|------|
| URL_CACHE | 原始 URL | LRU，size = 内容字节 | 15 分钟 | 50 MB |
| DOMAIN_CHECK_CACHE | hostname | LRU，仅缓存 allowed | 5 分钟 | 128 条 |

- `/clear` 命令调用 `clearWebFetchCache()` 清除两个缓存
- URL_CACHE 存储在原始 URL（非升级/重定向后的 URL）下
- Domain cache 更短 TTL，仅缓存正面结果（blocked/failed 不缓存，下次重检）

### 2.8 关键常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_URL_LENGTH` | 2000 | URL 长度上限 |
| `MAX_HTTP_CONTENT_LENGTH` | 10 MB | HTTP 响应体上限 |
| `FETCH_TIMEOUT_MS` | 60 秒 | 单次 HTTP 请求超时 |
| `DOMAIN_CHECK_TIMEOUT_MS` | 10 秒 | 域名预检超时 |
| `MAX_REDIRECTS` | 10 | 同主机重定向上限 |
| `MAX_MARKDOWN_LENGTH` | 100,000 | 内容截断阈值 |

### 2.9 外部依赖

| 依赖 | 用途 |
|------|------|
| `axios` | HTTP 客户端 |
| `lru-cache` | URL 缓存 + 域名检查缓存 |
| `turndown` | HTML → Markdown（懒加载，~1.4 MB 堆内存） |
| `api.anthropic.com/api/web/domain_info` | 域名阻止列表 |
| Anthropic API（Haiku 模型） | 内容处理二次模型 |

---

## 三、WebSearchTool — 网络搜索

### 3.1 文件清单

| 文件 | 职责 |
|------|------|
| `WebSearchTool.ts` | 工具定义、API 调用、流式处理 |
| `prompt.ts` | 动态 prompt（注入当前月份/年份） |
| `UI.tsx` | 终端渲染 |

### 3.2 输入/输出 Schema

```typescript
// 输入
z.strictObject({
  query: z.string().min(2),
  allowed_domains: z.array(z.string()).optional(),   // 白名单
  blocked_domains: z.array(z.string()).optional(),   // 黑名单
})
// 校验：allowed_domains 和 blocked_domains 不能同时指定

// 输出
z.object({
  query: z.string(),
  results: z.array(z.union([SearchResult, z.string()])),
  durationSeconds: z.number(),
})

// SearchResult
z.object({
  tool_use_id: z.string(),
  content: z.array(z.object({
    title: z.string(),
    url: z.string(),
  })),
})
```

### 3.3 核心架构——委托 API 服务端搜索

WebSearchTool **不自行进行 HTTP 搜索**。它将搜索完全委托给 Anthropic API 的服务端 `web_search_20250305` 工具：

```
WebSearchTool.call(input)
    │
    ├─ 1. 构建 BetaWebSearchTool20250305 schema
    │     { type: 'web_search_20250305', name: 'web_search',
    │       allowed_domains, blocked_domains, max_uses: 8 }
    │
    ├─ 2. queryModelWithStreaming()
    │     ├─ 系统提示: "You are an assistant for performing a web search tool use"
    │     ├─ 用户消息: "Perform a web search for the query: <query>"
    │     ├─ extraToolSchemas: [webSearchToolSchema]
    │     ├─ 模型选择（见 3.4）
    │     └─ 可选 toolChoice: { type: 'tool', name: 'web_search' }
    │
    ├─ 3. 流式处理事件循环
    │     ├─ content_block_start(server_tool_use) → 记录 tool_use_id
    │     ├─ content_block_delta(input_json_delta) → 累积 JSON，
    │     │   正则匹配 /"query"\s*:\s*"..."/ 提取搜索词
    │     │   → onProgress({ type: 'query_update', query })
    │     ├─ content_block_start(web_search_tool_result) → 搜索结果到达
    │     │   → onProgress({ type: 'search_results_received', resultCount, query })
    │     └─ assistant → 累积所有 content blocks
    │
    └─ 4. makeOutputFromSearchResponse()
          解析 content blocks 序列：
          [text] → [server_tool_use → web_search_tool_result → text/citation]+ → [text]
```

**关键设计**：每次 WebSearchTool 调用最多触发 **8 次搜索**（`max_uses: 8`），搜索模型可能在一次 API 调用中执行多轮搜索-读取-总结循环。

### 3.4 模型选择策略

```
tengu_plum_vx3 feature flag?
    ├─ true  → 使用 Haiku（小/快模型）
    │           thinking: disabled
    │           toolChoice: { type: 'tool', name: 'web_search' }（强制调用搜索）
    └─ false → 使用主循环模型（与用户对话相同的模型）
                thinking: 继承用户配置的 thinkingConfig
                toolChoice: undefined（模型自主决定）
```

### 3.5 结果格式化

`mapToolResultToToolResultBlockParam()` 将输出格式化为纯文本返回给主模型：

```
Web search results for query: "<query>"

<text summary from search model>

Links: [{"title":"...","url":"..."},...]

<more text and links...>

REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.
```

强制附加的 REMINDER 确保主模型在回复中引用来源。

### 3.6 Prompt（动态）

Prompt 注入当前月份和年份（通过 `getLocalMonthYear()`），可被 `CLAUDE_CODE_OVERRIDE_DATE` 环境变量覆盖：

```
CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section...

IMPORTANT - Use the correct year in search queries:
  - The current month is [April 2026]. You MUST use this year when searching...
```

### 3.7 可用性条件

`isEnabled()` 按 API Provider 决定：

| Provider | 条件 | 状态 |
|----------|------|------|
| firstParty | 无条件 | ✅ 始终可用 |
| vertex | model 名包含 `claude-opus-4`/`claude-sonnet-4`/`claude-haiku-4` | ✅ Claude 4.x |
| foundry | 无条件 | ✅ 始终可用 |
| bedrock | — | ❌ 不可用 |

### 3.8 用量追踪

API 响应中的 `server_tool_use.web_search_requests` 和 `web_fetch_requests` 计数器追踪搜索次数和服务端抓取次数，累加到 session usage 中。

### 3.9 权限模型

```typescript
checkPermissions() → { behavior: 'passthrough' }
// 无域名粒度控制，全有或全无
// 附带 localSettings 添加 WebSearch allow 规则的建议
```

---

## 四、WebBrowserTool — 浏览器交互（"Bagel"）

### 4.1 关键发现：没有独立的 "WebBrowserTool"

通过逆向 npm 包 `@anthropic-ai/claude-code` v2.1.97 确认：

> **"Bagel" 不是一个内置浏览器工具。** 它是一个**未启用的 UI 面板占位符**（页脚状态栏的 `bagelActive` 在当前版本硬编码为 `false`）。Claude Code 的浏览器自动化通过两个独立的 MCP 服务器实现：
>
> 1. **Computer Use MCP**（`mcp__computer-use__*`）— macOS 原生桌面控制
> 2. **Claude-in-Chrome MCP**（`mcp__claude-in-chrome__*`）— Chrome 扩展 WebSocket 桥接

### 4.2 Stub 代码

本地仓库中两个文件都是空壳：

```typescript
// WebBrowserTool.ts
export const WebBrowserTool = { name: 'WebBrowserTool', description: 'stub' }

// WebBrowserPanel.ts
export const WebBrowserPanel = { name: 'WebBrowserPanel', description: 'stub' }
```

通过 `feature('WEB_BROWSER_TOOL')` 编译时特性标志条件加载：

```typescript
// src/tools.ts:117
const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null

// src/screens/REPL.tsx:272
const WebBrowserPanelModule = feature('WEB_BROWSER_TOOL')
  ? require('../tools/WebBrowserTool/WebBrowserPanel.js')
  : null
```

### 4.3 "Bagel" 面板（UI 占位符）

**内部代号**："bagel"

**AppState 字段**（`src/state/AppStateStore.ts`）：

```typescript
bagelActive?: boolean       // 页脚显示浏览器状态 pill
bagelUrl?: string           // 当前页面 URL（显示在 pill 标签上）
bagelPanelVisible?: boolean // 粘性面板可见性开关
```

**UI 集成**：
- 页脚 pill 项：与 tasks、tmux、teams 等并列
- 粘性面板：类似 Tmux 的 "Tungsten" 面板，可切换显示
- `bagel_console` 附件类型：浏览器控制台输出可附加到消息

但在 v2.1.97 中，`bagelActive` 硬编码为 `false`——整个面板是**死代码**：

```js
t6 = H8((W8) => !1)  // always false — bagel panel never shows
```

### 4.4 Computer Use MCP 服务器（桌面控制）

通过 `--computer-use-mcp` 标志启动的内置 MCP 服务器，服务器名 `"computer-use"`。**仅 macOS**。

**原生依赖**：
- `@ant/computer-use-swift` — macOS 合成器级截图过滤（原生 Node addon）
- `@ant/computer-use-input` — 鼠标/键盘输入

#### 4.4.1 完整工具列表（26 个）

| 工具 | 说明 |
|------|------|
| `request_access` | 请求应用权限（用户对话框） |
| `request_teach_access` | 请求教学模式导览权限 |
| `screenshot` | 截取主显示器（合成器级过滤非授权应用） |
| `zoom` | 上次截图区域的高分辨率截取 |
| `left_click` / `double_click` / `triple_click` | 点击操作 |
| `right_click` / `middle_click` | 右键/中键点击 |
| `type` | 在焦点元素中输入文本 |
| `key` | 按键/组合键（如 "cmd+a"） |
| `scroll` | 在坐标处滚动（上/下/左/右） |
| `left_click_drag` | 拖拽操作 |
| `mouse_move` | 移动光标（不点击） |
| `open_application` | 启动/聚焦允许的应用 |
| `switch_display` | 切换监视器 |
| `list_granted_applications` | 列出已授权应用 |
| `read_clipboard` / `write_clipboard` | 剪贴板操作（需授权） |
| `wait` | 等待 N 秒（0-100） |
| `cursor_position` | 获取光标位置 |
| `hold_key` | 按住某键一段时间 |
| `left_mouse_down` / `left_mouse_up` | 鼠标按钮按下/释放 |
| `computer_batch` | 一次调用执行多个操作 |
| `teach_step` / `teach_batch` | 教学模式：显示工具提示覆盖层 |

#### 4.4.2 应用分层权限系统

应用按 Bundle ID 分为三个层级：

| 层级 | 权限 | 典型应用 |
|------|------|----------|
| **`full`** | 所有交互 | 大多数应用（默认） |
| **`click`** | 仅左键点击和滚动；无输入、无右键、无修饰键 | 终端/IDE（Terminal、iTerm2、VS Code、JetBrains 等） |
| **`read`** | 仅截图，无交互 | 浏览器（Safari、Chrome、Firefox、Edge、Arc 等） |

**设计意图**：
- 浏览器为 `read`——交互通过 Claude-in-Chrome MCP
- 终端为 `click`——输入通过 Bash 工具
- 交易应用和媒体应用被阻止

**授权标志**（独立请求）：`clipboardRead`、`clipboardWrite`、`systemKeyCombos`

#### 4.4.3 截图实现

- 使用 `@ant/computer-use-swift` 原生模块进行合成器级截图过滤（隐藏非授权应用窗口）
- 输出格式：JPEG（quality = 0.75）
- 自动缩放：约束分辨率到 `maxTargetPx=1568, maxTargetTokens=1568, pxPerToken=28`
- 像素验证：点击前可选比较上次截图与当前屏幕，检测变化

#### 4.4.4 输入实现

- 鼠标/键盘通过 `@ant/computer-use-input` 原生 addon
- 拖拽：60fps 三次缓动曲线平滑动画（`1 - Math.pow(1-X, 3)`）
- 长文本输入快捷路径：多行 `type` 调用使用剪贴板粘贴（`cmd+v`）而非逐字符输入
- 剪贴板安全：`click` 层级应用激活时，暂存真实剪贴板、操作后清除并恢复
- 全局 Escape 热键：通过 `@ant/computer-use-swift` 注册为紧急退出机制

#### 4.4.5 Session 管理

- **文件锁**：`computer-use.lock` 防止多个 Claude 会话同时使用桌面控制
- 锁文件内容：`{sessionId, pid, acquiredAt}`
- **多监视器**：`listDisplays()`、`switch_display`、自动解析
- **会话结束**：`unhideComputerUseApps()` 恢复被隐藏的窗口

#### 4.4.6 教学模式（Guided Tour）

独立的交互模型，Claude 在用户屏幕上显示工具提示覆盖层：
- `request_teach_access` 打开全屏覆盖
- `teach_step` 显示包含 `explanation`、`next_preview`、`anchor` 坐标和 `actions` 的工具提示
- 用户点击 "Next" 推进、"Exit" 退出
- 教学期间 Claude 主窗口隐藏

### 4.5 Claude-in-Chrome MCP（浏览器扩展桥接）

通过 WebSocket 连接到 Chrome 扩展的 MCP 服务器，跨平台（需安装扩展）。

#### 4.5.1 工具列表（16 个）

| 工具 | 说明 |
|------|------|
| `javascript_tool` | 在页面上下文中执行 JS |
| `read_page` | 获取页面无障碍树 |
| `find` | 自然语言查找元素 |
| `form_input` | 通过元素引用设置表单值 |
| `computer` | 浏览器视口操作（截图/点击/输入/滚动/缩放/拖拽等） |
| `navigate` | 导航到 URL / 前进 / 后退 |
| `resize_window` | 调整浏览器窗口大小 |
| `gif_creator` | 将浏览器操作录制为 GIF |
| `upload_image` | 上传截图/图片到页面元素 |
| `get_page_text` | 提取文章文本内容 |
| `tabs_context_mcp` / `tabs_create_mcp` | 标签页上下文/创建 |
| `update_plan` | 提交操作计划供用户批准 |
| `read_console_messages` | 读取浏览器控制台输出 |
| `read_network_requests` | 读取 HTTP 网络请求 |
| `shortcuts_list` / `shortcuts_execute` | 列出/执行浏览器快捷键 |
| `switch_browser` | 切换 Chrome 实例 |

### 4.6 工具选择优先级

系统 prompt 定义了三层工具选择层次：

```
1. 专用 MCP — 如果目标应用有专用 MCP 工具，优先使用
2. Chrome MCP (mcp__claude-in-chrome__*) — Web 应用，DOM 感知且更快
3. Computer Use MCP (mcp__computer-use__*) — 最后手段，基于像素
```

关键规则：
- 永远不要用 computer-use 工具点击 web 链接
- 浏览器是 `read` 层级——仅截图
- 终端是 `click` 层级——不能输入
- 使用前必须先调用 `request_access`
- Computer-use 工具需通过 ToolSearch 批量加载（`query: "computer-use", max_results: 30`）

### 4.7 与 system prompt 的分工声明

**来源**：`src/utils/claudeInChrome/prompt.ts`

```
WebBrowser: 开发用途（dev servers、JS 执行、控制台、截图）→ 当前为 stub
Claude-in-Chrome: 用户真实 Chrome（登录态、OAuth、computer-use）→ 活跃
Computer Use: macOS 原生桌面（全应用覆盖，权限分层）→ 活跃
```

**推断**：WebBrowserTool/bagel 可能是计划中的**内置隔离浏览器**（类似 Playwright），用于开发场景（dev server 调试），以区别于 Chrome 扩展（用户浏览器）和桌面控制（像素级）。目前在 UI 层已有面板框架（pages/panel/footer），但工具逻辑尚未实现。

---

## 五、全景对比

| 维度 | WebFetchTool | WebSearchTool | Computer Use MCP | Chrome MCP |
|------|-------------|---------------|-----------------|------------|
| **架构** | 客户端 GET + Haiku | API 服务端搜索 | macOS 原生 addon | Chrome 扩展 WS 桥 |
| **平台** | 跨平台 | 跨平台（Bedrock 除外） | macOS only | 跨平台（需扩展） |
| **内容处理** | Haiku 二次模型 | 搜索模型内置总结 | 截图 JPEG | DOM/JS/无障碍树 |
| **安全模型** | 域名阻止列表 + 预批准 | Anthropic 服务端 | 应用分层权限 + Session 锁 | Chrome 扩展沙盒 |
| **版权合规** | 双重 prompt 策略 | 搜索模型内置 | N/A（截图） | N/A |
| **域名粒度** | `domain:hostname` 规则 | 全有或全无 | 按应用 Bundle ID | 按标签页 |
| **缓存** | 15 分钟 LRU（50 MB） | 无 | 无 | 无 |
| **工具类型** | 内置（shouldDefer） | 内置（shouldDefer） | 内置 MCP 服务器 | 外部 MCP 桥接 |

---

## 六、配置项速查

### 环境变量

| 变量 | 工具 | 说明 |
|------|------|------|
| `ANTHROPIC_SMALL_FAST_MODEL` | WebFetch | 覆盖 Haiku 模型名 |
| `CLAUDE_CODE_USE_VERTEX` | WebSearch | Vertex AI provider |
| `CLAUDE_CODE_USE_BEDROCK` | WebSearch | Bedrock provider（禁用 WebSearch） |
| `CLAUDE_CODE_USE_FOUNDRY` | WebSearch | Foundry provider |
| `CLAUDE_CODE_OVERRIDE_DATE` | WebSearch | 覆盖当前日期（测试用） |
| `USER_TYPE=ant` | WebFetch | 启用 `tengu_web_fetch_host` 分析事件 |

### Settings

| 键 | 工具 | 说明 |
|----|------|------|
| `skipWebFetchPreflight` | WebFetch | 跳过域名阻止列表预检（企业客户） |

### Feature Flags

| Flag | 工具 | 说明 |
|------|------|------|
| `tengu_plum_vx3` | WebSearch | 使用 Haiku + 强制 tool_choice |
| `WEB_BROWSER_TOOL` | WebBrowser | 启用浏览器工具（Anthropic 内部） |

---

## 七、安全设计要点

1. **数据外泄防护**：WebFetch 仅支持 GET，预批准列表不继承到 sandbox POST/上传
2. **SSRF 防护**：URL 校验拒绝单标签主机名、带凭据 URL；域名预检阻止访问内网
3. **重定向劫持防护**：禁用自动跟随，手动校验每跳（同主机+同协议+同端口+无凭据）
4. **出口代理检测**：识别 403 + `x-proxy-error` 响应，抛出结构化错误
5. **版权保护**：非预批准域强制 125 字符引用上限 + 歌词禁止
6. **资源限制**：10 MB 响应上限、60 秒超时、50 MB 缓存上限
