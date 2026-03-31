# Claude Code 模块依赖关系图

> 统一管理所有模块间的依赖和交互关系。
> 各模块分析文档不再单独写「模块交互」章节。

## 依赖矩阵

| 模块 | 依赖于 | 被依赖于 |
|------|--------|---------|
| **types** | 无 | 所有模块 |
| **constants** | types | utils, services, commands, main |
| **native-ts** | 无 | utils |
| **utils** | types, constants, native-ts | 所有模块（19+ 个） |
| **services** | utils, types, constants | main, QueryEngine, tools, commands, utils, hooks, components |
| **tools** | services, utils, types, hooks | main, QueryEngine, commands, tools.ts |
| **commands** | utils, tools, services, types | main, commands.ts |
| **query** | utils, services, tools | QueryEngine, main |
| **hooks** | utils, types, services, components | components, screens, main |
| **components** | utils, hooks, types, services | main, screens, ink |
| **ink** | components, utils | main, components |
| **screens** | components, hooks, utils, services | main |
| **skills** | utils, services, types | main, tools |
| **tasks** | utils, services, types, tools | main, commands |
| **entrypoints** | utils, services, types | main, QueryEngine |
| **bridge** | utils, services, cli, types | main, cli |
| **cli** | utils, services, types | main, bridge |
| **remote** | utils, services, types | main, cli |
| **server** | utils, services | main |
| **coordinator** | utils | main |
| **plugins** | utils, services | main |
| **state** | types, utils | components, hooks, main |
| **context** | utils, services, types | main, QueryEngine |
| **memdir** | utils | main, QueryEngine |
| **bootstrap** | utils | main, entrypoints |
| **keybindings** | utils, types | main, hooks |
| **vim** | utils, hooks | main, hooks |
| **buddy** | components, utils | components, main |
| **voice** | utils | main |
| **upstreamproxy** | utils | main, services |
| **migrations** | utils | main |

---

## 详细依赖关系图

### 核心架构分层（ASCII 图）

```
┌─────────────────────────────────────────────────────────────────────┐
│                          第 8 层：编排引擎                            │
│                            main.tsx                                   │
│                    (依赖所有下层模块)                                   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────────────┐
│                       第 7 层：核心工作流                              │
│    QueryEngine.ts ←──→ query.ts    commands.ts ←──→ tools.ts        │
│         (LLM引擎)    (上下文管理)   (命令注册)      (工具注册)          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
        ┌──────────────────────┼─────────────────────┐
        │                      │                      │
┌───────┴──────┐      ┌────────┴──────┐      ┌───────┴──────┐
│  第 5 层：网关  │      │  第 4 层：UI   │      │ 第 3 层：功能  │
│  bridge/     │      │ components/   │      │  tools/      │
│  cli/        │      │  hooks/       │      │  commands/   │
│  remote/     │      │  ink/         │      │  skills/     │
│  server/     │      │  screens/     │      │  tasks/      │
│  entrypoints/│      └───────────────┘      │  query/      │
└──────────────┘                             └──────────────┘
        │                                           │
        └──────────────────┬────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────────┐
│                      第 2 层：服务层                                   │
│                         services/                                     │
│        (Claude API + MCP + OAuth + Analytics + Plugins)               │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────────┐
│                      第 1 层：基础设施                                 │
│    utils/ (180K 行)   state/   context/   bootstrap/   memdir/       │
│    migrations/   upstreamproxy/   keybindings/                        │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────────┐
│                      第 0 层：无依赖基础                               │
│              types/        constants/        native-ts/               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 关键交互路径

### 路径 1：用户命令执行

```
用户输入斜杠命令
    ↓
main.tsx → Commander.js 解析参数
    ↓
commands.ts → 命令查询和分派
    ↓
commands/<cmd>/index.ts → 具体命令处理
    ↓
调用相关工具 (tools/*)
    ├─ FileEditTool → 修改文件
    ├─ BashTool → 执行 Shell 命令
    ├─ GrepTool → 搜索代码
    └─ 其他工具
    ↓
components/* → React Ink 渲染结果
    ↓
ink/* → 输出到终端
    ↓
用户看到结果
```

### 路径 2：LLM 查询（Agent 循环）

```
QueryEngine.query()
    │
    ├─ utils/messages.js → 构建系统 Prompt + 历史消息
    ├─ query.ts → 收集代码上下文（文件内容、目录结构、符号）
    ├─ context/ → 收集系统上下文
    │
    ↓
services/api/claude.js → 调用 Claude API（流式）
    │
    ↓ 接收响应
    │
    ├─ [文本块] → 通过 components/* 展示给用户
    └─ [工具调用块]
            ↓
        Tool.ts → 匹配工具定义
            ↓
        utils/permissions/ → 权限检查
            ├─ AUTO → 直接执行
            └─ 需授权 → components/* 弹出对话框 → 用户确认
                        ↓
                    tools/<ToolName>/ → 执行具体工具
                        ↓
                    收集工具输出 (ToolResult)
                        ↓
                    进入下一轮 LLM 调用
```

### 路径 3：IDE 集成（VS Code / JetBrains）

```
IDE 插件
    ↓ (WebSocket/IPC)
bridge/bridgeMain.ts → 桥接层核心
    ↓
bridge/sessionRunner.ts → 会话执行
    ↓
cli/remoteIO.ts → 远程 I/O 处理
    ↓
main.tsx → 接收并处理命令
    ↓
QueryEngine.ts / tools/* → 处理请求
    ↓
cli/structuredIO.ts → 结构化输出（JSON/NDJSON）
    ↓
bridge/* → 格式化并返回给 IDE
    ↓
IDE → 展示结果（差异、建议等）
```

### 路径 4：权限检查

```
工具即将被执行
    ↓
hooks/useCanUseTool.tsx → 触发权限检查
    ↓
utils/permissions/permissionSetup.ts → 查询权限配置
    ↓
判断权限模式:
    ├─ AUTO_ALLOWED → 直接执行
    ├─ NEEDS_USER_APPROVAL
    │       ↓
    │   components/dialogs/* → 展示授权对话框
    │       ↓
    │   用户点击 Allow / Deny
    │       ↓
    │   ├─ Allow → 执行工具（可选：记入永久白名单）
    │   └─ Deny → 中止，返回拒绝错误
    └─ ALWAYS_DENIED → 直接拒绝
```

### 路径 5：插件和技能加载

```
main.tsx 启动
    ↓
entrypoints/init.ts → 初始化序列
    ↓
utils/plugins/installedPluginsManager.ts → 扫描已安装插件
    ↓
services/plugins/ → 注册插件 API
    ↓
plugins/bundled/ → 加载内置插件

同时（技能加载）:
utils/skills/skillChangeDetector.ts → 监听技能目录变更
    ↓
skills/loadSkillsDir.ts → 读取 ~/.claude/skills/
    ↓
tools/SkillTool/ → 将每个技能暴露为可调用工具
    ↓
tools.ts → 注册到工具注册表
    ↓
QueryEngine.ts → 可在 LLM 对话中被调用
```

### 路径 6：多代理协调

```
main.tsx → 检测 Swarm/Teammate 模式
    ↓
utils/swarm/ → 初始化 Swarm 后端
    ↓
coordinator/coordinatorMode.ts → 协调器逻辑
    ↓
tasks/LocalAgentTask.ts / RemoteAgentTask.ts → 创建子 Agent 任务
    ↓
每个子 Agent 运行独立的 QueryEngine 实例
    ↓
子 Agent 完成 → 结果汇总回协调器
    ↓
main.tsx → 展示给用户
```

---

## 高频被依赖模块（需优先理解）

| 排名 | 模块 | 被直接依赖次数 | 说明 |
|------|------|--------------|------|
| 1 | **utils** | 19+ | 基础工具库，几乎所有模块都依赖 |
| 2 | **types** | 18+ | TypeScript 类型，全局使用 |
| 3 | **services** | 8+ | 服务适配层 |
| 4 | **constants** | 6+ | 全局常量 |
| 5 | **hooks** | 4 | React hooks，UI 层共用 |

---

## 模块间通信模式

### 1. 直接函数调用
最常见的模式，模块 A 直接 import 并调用模块 B 的函数。

```
QueryEngine.ts → import { streamQuery } from './services/api/claude.js'
```

### 2. React Context 传递
UI 状态通过 React Context 在组件树中传递。

```
state/AppState.tsx (Provider)
    ↓ Context
components/* / hooks/* (Consumer)
```

### 3. 事件和回调
工具调用结果通过回调异步传递。

```
QueryEngine → onToolResult(callback)
    ↓
tools/* → 执行 → callback(result)
    ↓
QueryEngine → 继续下一轮
```

### 4. Stream（流式传输）
Claude API 响应和 IDE 通信使用流式传输。

```
services/api/claude.js → ReadableStream
    ↓
QueryEngine.ts → AsyncGenerator
    ↓
main.tsx / components/* → 实时渲染
```

---

## 依赖风险分析

### 循环依赖风险（低）
项目分层清晰，通过以下方式避免循环：
- `types` 和 `constants` 不依赖任何模块
- `utils` 不依赖 `services`（反向依赖通过依赖注入处理）
- UI 层（components, hooks）不被业务逻辑层（tools, commands）依赖

### 高依赖模块变更风险
- **utils 变更**：影响所有 19+ 个依赖模块
- **types 变更**：影响全局 TypeScript 类型检查
- **services/api/claude.js 变更**：影响 LLM 查询核心流程

### 隔离良好的模块（低风险）
- `voice` — 仅被 main 依赖
- `buddy` — 仅被 components 和 main 依赖
- `vim` — 仅被 main 和 hooks 依赖
- `coordinator` — 仅被 main 依赖
