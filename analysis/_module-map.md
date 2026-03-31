# Claude Code 模块地图

> 自动生成于 2026-03-31，基于 claude-code 仓库扫描

## 项目概况

- **名称**: Claude Code
- **定位**: Anthropic 的官方 CLI 工具，支持从终端与 Claude 交互执行软件工程任务（代码编辑、Shell 执行、文件搜索、工作流协调等）
- **语言/框架**: TypeScript (Bun 运行时 + React + Ink 终端 UI)
- **文件总数**: 1,884 个源代码文件
- **代码行数**: ~513K 行
- **发现方式**: npm source map 泄露（源码通过 sourcemap 可访问）

---

## 模块列表

| # | 模块名 | 路径 | 类型 | 文件数 | 行数 | 复杂度 | 分析模板 |
|---|--------|------|------|--------|------|--------|---------|
| 1 | **utils** | src/utils | infra | 564 | 180,472 | very-high | 04-analysis-infra |
| 2 | **components** | src/components | ui | 389 | 81,546 | very-high | 05-analysis-ui |
| 3 | **services** | src/services | infra | 130 | 53,680 | very-high | 04-analysis-infra |
| 4 | **tools** | src/tools | agent | 184 | 50,828 | very-high | 02-analysis-agent |
| 5 | **commands** | src/commands | gateway | 189 | 26,428 | very-high | 01-analysis-gateway |
| 6 | **hooks** | src/hooks | ui | 104 | 19,204 | high | 05-analysis-ui |
| 7 | **ink** | src/ink | ui | 96 | 19,842 | high | 05-analysis-ui |
| 8 | **bridge** | src/bridge | gateway | 31 | 12,613 | high | 01-analysis-gateway |
| 9 | **cli** | src/cli | gateway | 19 | 12,353 | high | 01-analysis-gateway |
| 10 | **query** | src/query | infra | 4 | 652 | medium | 04-analysis-infra |
| 11 | **screens** | src/screens | ui | 3 | 5,977 | medium | 05-analysis-ui |
| 12 | **tasks** | src/tasks | agent | 12 | 3,286 | medium | 02-analysis-agent |
| 13 | **entrypoints** | src/entrypoints | gateway | 8 | 4,051 | medium | 01-analysis-gateway |
| 14 | **skills** | src/skills | plugin | 20 | 4,066 | medium | 03-analysis-plugin |
| 15 | **keybindings** | src/keybindings | ui | 14 | 3,159 | low | 05-analysis-ui |
| 16 | **constants** | src/constants | infra | 21 | 2,648 | low | 04-analysis-infra |
| 17 | **native-ts** | src/native-ts | infra | 4 | 4,081 | low | 04-analysis-infra |
| 18 | **types** | src/types | infra | 11 | 3,446 | low | 04-analysis-infra |
| 19 | **migrations** | src/migrations | infra | 11 | 603 | low | 04-analysis-infra |
| 20 | **context** | src/context | infra | 9 | 1,004 | low | 04-analysis-infra |
| 21 | **state** | src/state | infra | 6 | 1,190 | low | 04-analysis-infra |
| 22 | **buddy** | src/buddy | ui | 6 | 1,298 | low | 05-analysis-ui |
| 23 | **vim** | src/vim | ui | 5 | 1,513 | low | 05-analysis-ui |
| 24 | **remote** | src/remote | gateway | 4 | 1,127 | low | 01-analysis-gateway |
| 25 | **upstreamproxy** | src/upstreamproxy | infra | 2 | 740 | low | 04-analysis-infra |
| 26 | **plugins** | src/plugins | plugin | 2 | 182 | low | 03-analysis-plugin |
| 27 | **server** | src/server | gateway | 3 | 358 | low | 01-analysis-gateway |
| 28 | **coordinator** | src/coordinator | agent | 1 | 369 | low | 02-analysis-agent |
| 29 | **memdir** | src/memdir | infra | 8 | 1,736 | low | 04-analysis-infra |
| 30 | **bootstrap** | src/bootstrap | infra | 1 | 1,758 | low | 04-analysis-infra |
| 31 | **voice** | src/voice | ui | 1 | 54 | low | 05-analysis-ui |

### 核心工作流文件（非模块目录）

| 文件 | 行数 | 角色 |
|------|------|------|
| src/main.tsx | ~804K（编译后） | CLI 主入口和命令编排引擎 |
| src/QueryEngine.ts | ~47K | LLM 查询引擎 |
| src/query.ts | ~69K | 查询和上下文管理 |
| src/commands.ts | ~25K | 命令注册中心 |
| src/tools.ts | ~17K | 工具注册中心 |
| src/Tool.ts | ~30K | 工具类型定义基类 |

---

## 依赖关系图（简版）

```
                    ┌──────────────────────────────┐
                    │         main.tsx              │
                    │     (CLI 主入口，编排引擎)      │
                    └──────────┬───────────────────┘
                               │
         ┌─────────────────────┼──────────────────────┐
         ↓                     ↓                      ↓
    ┌──────────┐         ┌──────────┐          ┌──────────┐
    │commands.ts│         │QueryEngine│          │tools.ts  │
    │命令注册中心│         │LLM 引擎   │          │工具注册中心│
    └─────┬────┘         └─────┬────┘          └─────┬────┘
          │                    │                      │
          ↓                    ↓                      ↓
    ┌──────────┐         ┌──────────┐          ┌──────────┐
    │commands/*│         │query.ts  │          │tools/*   │
    │100+斜杠命令│        │上下文管理 │          │40+工具   │
    └──────────┘         └──────────┘          └──────────┘
          │                    │                      │
          └──────────┬─────────┘──────────────────────┘
                     ↓
          ┌──────────────────────────┐
          │  services/  + utils/     │
          │  (服务层)     (工具库)    │
          └──────────┬───────────────┘
                     ↓
          ┌──────────────────────────┐
          │  types/ + constants/     │
          │  (类型定义)   (全局常量)  │
          └──────────────────────────┘

UI 层（独立渲染）：
components/* → hooks/* → ink/* → 终端
```

（详细依赖关系见 analysis/_dependency-graph.md）

---

## 模块分层结构

```
第 0 层（无依赖基础）
├── types/           TypeScript 类型定义
├── constants/       全局常量
└── native-ts/       原生工具函数

第 1 层（基础设施）
├── utils/           工具库（依赖: types, constants）
├── state/           状态管理（依赖: types, utils）
├── context/         上下文管理（依赖: types, utils）
└── bootstrap/       启动初始化（依赖: utils）

第 2 层（服务层）
├── services/        外部服务集成（依赖: utils, types）
├── migrations/      配置迁移（依赖: utils）
├── memdir/          持久化内存（依赖: utils）
└── upstreamproxy/   代理配置（依赖: utils）

第 3 层（功能实现）
├── tools/           Agent 工具（依赖: services, utils）
├── commands/        CLI 命令（依赖: utils, tools, services）
├── query/           查询系统（依赖: utils, services, tools）
├── skills/          技能系统（依赖: utils, services）
├── tasks/           任务管理（依赖: utils, services, tools）
└── plugins/         插件核心（依赖: utils, services）

第 4 层（UI 和交互）
├── hooks/           React hooks（依赖: utils, services）
├── components/      UI 组件（依赖: utils, hooks, services）
├── ink/             Ink 渲染器（依赖: components, utils）
├── screens/         全屏 UI（依赖: components, hooks）
├── keybindings/     快捷键（依赖: utils）
└── vim/             Vim 模式（依赖: utils, hooks）

第 5 层（网关）
├── cli/             CLI I/O（依赖: utils, services）
├── bridge/          IDE 桥接（依赖: utils, services, cli）
├── remote/          远程会话（依赖: utils, services）
├── server/          服务器模式（依赖: utils, services）
└── entrypoints/     入口点（依赖: utils, services）

第 6 层（协调）
└── coordinator/     多代理协调（依赖: utils）

第 7 层（核心工作流引擎）
├── tools.ts         工具注册中心
├── commands.ts      命令注册中心
├── QueryEngine.ts   LLM 查询引擎
├── query.ts         查询管理
└── Tool.ts          工具基类

第 8 层（顶级编排）
└── main.tsx         CLI 主入口（依赖几乎所有模块）
```

---

## 建议分析顺序

基于依赖关系，建议按以下顺序分析（被依赖多的优先）:

### 第一阶段：基础层
1. **types** — 理解 Message、Tool、PermissionResult 等核心类型
2. **constants** — 全局常量和配置
3. **native-ts** — 原生工具函数

### 第二阶段：基础设施
4. **utils** — 最大的模块，核心关注：settings/、permissions/、plugins/、model/、messages/、swarm/、git/
5. **services** — 服务集成层，核心关注：api/claude.js（Claude API）、mcp/（MCP 集成）

### 第三阶段：功能模块
6. **tools** — Agent 工具实现（40+ 工具）
7. **commands** — CLI 命令实现（100+ 命令）
8. **skills** — 技能系统
9. **tasks** — 任务管理

### 第四阶段：查询和交互
10. **query** — 查询和上下文管理
11. **QueryEngine.ts** — LLM 查询引擎（核心）
12. **hooks** — React hooks
13. **components** — UI 组件库
14. **ink** — 终端渲染器

### 第五阶段：系统集成
15. **entrypoints** — 入口点和 SDK
16. **bridge** — IDE 集成
17. **cli** — CLI I/O 层
18. **main.tsx** — 全局编排引擎

---

## 用户确认项

- [ ] 模块列表是否完整？是否需要拆分/合并？
  - `utils`（180K 行，32 子目录）是否需要拆分为子模块？
  - `components`（81K 行，32 子目录）是否需要拆分？
- [ ] 模块类型分类是否准确？
  - `services` 被标记为 `infra`，是否更适合标记为独立类型？
- [ ] 是否有需要跳过的模块？（如 voice、buddy 等小型模块）
- [ ] 分析范围：全量 / 指定模块？
- [ ] 是否有参考资料可以提供？（技术博客、论文、架构文档的 URL 或本地路径）
