# LiteLLM Hook 动态路由：Claude Code 支线任务识别与模型切换

> 参考文章：[Claude Code 接入自建开源模型：企业私有化与降本实践](https://aws.amazon.com/cn/blogs/china/claude-code-open-source-model-enterprise-practice/)（2026-04-02）

---

## 一、两种"Hook"概念的区分

文章中涉及两个层次的 Hook，容易混淆：

| 层次 | 名称 | 定义位置 | 触发者 |
|------|------|----------|--------|
| **Claude Code 原生 Hook** | `PreToolUse` / `PostToolUse` / `SubagentStart` 等 | `settings.json` / `settings.local.json` | Claude Code 运行时 |
| **LiteLLM Callback Hook** | `log_pre_api_call` / `async_post_call_streaming_iterator_hook` | LiteLLM `config.yaml` 的 `callbacks` | LiteLLM Proxy |

文章的核心玩法是：**用 LiteLLM 层的 callback hook 去识别 Claude Code 原生 hook 触发的 LLM 调用，并动态改变路由目标**。

---

## 二、Claude Code 原生 Hook 系统

### 2.1 完整事件列表

来源：`src/entrypoints/sdk/coreTypes.ts:25`

```
PreToolUse          — 工具调用执行前（可拦截/批准/拒绝）
PostToolUse         — 工具调用成功后
PostToolUseFailure  — 工具调用失败后
Notification        — Claude Code 发出通知时
UserPromptSubmit    — 用户提交 prompt 后、模型处理前
SessionStart        — 会话启动时（可注入初始上下文）
SessionEnd          — 会话结束/clear 时
Stop                — 模型完成一轮输出时（含 Agent 验证逻辑）
StopFailure         — Stop hook 执行失败时
SubagentStart       — SubAgent 启动时
SubagentStop        — SubAgent 结束时
PreCompact          — 上下文压缩前
PostCompact         — 上下文压缩后
PermissionRequest   — 权限请求时（可编程决策 allow/deny）
PermissionDenied    — 权限被拒绝时
Setup               — 应用初始化阶段（最早期，早于 SessionStart）
TeammateIdle        — 多 Agent 团队中某成员空闲时
TaskCreated         — 任务创建时（TodoWrite 等）
TaskCompleted       — 任务完成时
Elicitation         — 表单/交互式输入触发时
ElicitationResult   — 表单填写完成后
ConfigChange        — 配置变更时
WorktreeCreate      — Git worktree 创建时
WorktreeRemove      — Git worktree 移除时
InstructionsLoaded  — CLAUDE.md 加载后
CwdChanged          — 工作目录变更时
FileChanged         — 被监听的文件发生变化时
```

### 2.2 Hook 类型

来源：`src/schemas/hooks.ts`

| 类型 | 描述 |
|------|------|
| `command` | Shell 命令（最常用，支持 bash/powershell） |
| `prompt` | 直接调用 LLM 评估（`$ARGUMENTS` 占位符） |
| `agent` | 启动独立 Agent 子任务执行验证 |
| `http` | POST 请求到外部 HTTP 端点 |
| `callback` | 内部代码注册的 TypeScript 函数 hook |

### 2.3 执行流程

```
用户配置 hooks（settings.json）
        ↓
Claude Code 运行时触发事件（如工具调用前）
        ↓
hooksSettings.getAllHooks() 收集所有来源的 hooks
    - userSettings（~/.claude/settings.json）
    - projectSettings（.claude/settings.json）
    - localSettings（.claude/settings.local.json）
    - pluginHook（~/.claude/plugins/*/hooks/hooks.json）
    - sessionHook（运行时动态注册，内存级别）
        ↓
matcher 过滤（工具名/权限规则语法，如 "Bash(git *)"）
        ↓
并发执行匹配的 hook（command / prompt / agent / http / callback）
        ↓
处理返回值（JSON 或纯文本）
    - continue: false → 阻止继续执行
    - decision: "block" → 拦截工具调用
    - permissionDecision: "allow"/"deny"/"ask" → 权限决策
    - additionalContext → 注入上下文到对话
    - updatedInput → 修改工具调用参数
        ↓
聚合多个 hook 的结果（AggregatedHookResult）
        ↓
主循环根据结果决定后续行为
```

关键源码位置：
- 执行入口：`src/utils/hooks.ts`（`runHooks` / `runHook`）
- 结果聚合：`src/utils/hooks.ts`（`aggregateHookResults`）
- 信任检查：`src/utils/hooks.ts:286`（`shouldSkipHookDueToTrust`）
- 事件广播：`src/utils/hooks/hookEvents.ts`

### 2.4 Hook 执行模式

- **同步（默认）**：阻塞等待 hook 完成，结果影响后续行为
- **异步（`async: true`）**：后台执行，不阻塞主流程，结果不影响当前操作
- **异步唤醒（`asyncRewake: true`）**：后台执行，但退出码为 2 时会将错误注入消息队列唤醒模型

---

## 三、文章中的核心发现：Hook 条件评估是支线任务

### 3.1 什么是 Hook 条件评估

当用户配置了 `prompt` 或 `agent` 类型的 hook，且带有 `if` 条件时，Claude Code 会在 hook 执行前调用 LLM 来判断是否满足条件。这个调用使用固定的 system prompt：

```
[System Prompt]: You are evaluating a hook in Claude Code.
Your response must be a JSON object matching one of the following schemas:
1. If the condition is met, return: {"ok": true}
2. If the condition is not met, return: {"ok": false, "reason": "Reason for why it is not met"}
```

这个调用在 Claude Code 内部被标识为 `agent-prompt-hook-condition-evaluator`。

### 3.2 为什么是支线任务

| 维度 | 主线任务（如代码重构） | 支线任务（如 hook 条件评估） |
|------|----------------------|---------------------------|
| 上下文依赖 | 完整会话上下文，依赖 Prompt Cache | 独立短上下文，cache 命中率低 |
| 推理复杂度 | 需要深度推理 | 简单判断/模式匹配 |
| 输出格式 | 自然语言 + 工具调用 | 固定 JSON `{"ok": bool}` |
| 模型要求 | 顶级模型（Claude Sonnet） | 小模型可胜任 |
| 响应速度 | 相对宽松 | 要求较高（影响工具调用延迟） |

---

## 四、LiteLLM Callback Hook 的完整过程

### 4.1 两个关键 Callback

```yaml
# config.yaml
litellm_settings:
  callbacks:
    - "stream_anthropic_schema_fixer.hook"        # Hook 1：Schema 修复
    - "dynamic_tagging_handler.proxy_handler_instance"  # Hook 2：动态路由
```

### 4.2 Hook 1：动态路由（`log_pre_api_call`）

**触发时机**：LiteLLM 将请求发送给后端模型 **之前**

**作用**：检测请求是否为 hook 条件评估任务，如果是则修改目标模型为开源模型

```python
def log_pre_api_call(self, kwargs, response_obj, start_time, end_time):
    messages = kwargs.get("messages", [])
    full_text = self._extract_all_text(messages)
    if self._is_hook_evaluator_prompt(full_text):
        kwargs["model"] = "sagemaker-kimi-2-5"  # 路由到开源模型
    return kwargs
```

**识别逻辑**：多特征阈值匹配（至少命中 3 个关键字才生效，避免误判）：
```python
markers = [
    "You are evaluating a hook in Claude Code",
    "hook condition",
    "Return your evaluation as a JSON object",
    '"satisfied": true'
]
match_count >= 3  # 触发路由切换的阈值
```

### 4.3 Hook 2：Streaming Schema 修复（`async_post_call_streaming_iterator_hook`）

**触发时机**：LiteLLM 收到后端模型的流式响应后、转发给客户端 **之前**，逐 chunk 拦截

**背景问题**：Claude Code 的流式解析器完全针对 Anthropic Messages API 设计，期望严格的 schema。开源模型基于 OpenAI API 标准，经过 LiteLLM 格式转换后字段不完整（如缺少 `cache_creation_input_tokens`、`usage` 对象）。

**修复内容**：
- `message_start` 事件：补全 `usage` 字段（含 `cache_creation_input_tokens` 等）
- `message_delta` 事件：补全 `usage.output_tokens`
- `message_stop` 事件：补全完整的 `usage` 统计

```python
async def async_post_call_streaming_iterator_hook(
    self, user_api_key_dict, response: AsyncGenerator, request_data: dict
) -> AsyncGenerator:
    async for chunk in response:
        if event_type == "message_start":
            self._fix_message_start(data_json)
        elif event_type == "message_delta":
            self._fix_message_delta(data_json)
        elif event_type == "message_stop":
            self._fix_message_stop(data_json, last_usage)
        yield self._rebuild_sse(event_type, data_json)
```

**为何必要**：不修复的话 Claude Code 可能 fallback 到非流式模式，而非流式接口在长代码生成场景可能触发 SageMaker 60s 超时。

### 4.4 完整调用链

```
Claude Code
    │ (streaming, Anthropic Messages API)
    ↓
LiteLLM Proxy（监听 8080）
    │
    ├─ [log_pre_api_call] ─→ 检测任务类型 → 修改 kwargs["model"]
    │
    │ (路由到 SageMaker 或 Bedrock)
    ↓
后端模型（SageMaker Kimi / Bedrock Claude）
    │
    ↓
LiteLLM 接收流式响应
    │
    ├─ [async_post_call_streaming_iterator_hook] ─→ 逐 chunk 修复 schema
    │
    ↓
Claude Code（接收到合规的 Anthropic 格式 SSE 流）
```

---

## 五、Prompt Cache 影响分析

### 5.1 Cache Key 的构成

来源：`src/services/api/promptCacheBreakDetection.ts:28-68`

服务端 cache 的匹配条件（任一项变化均导致 cache break）：

```
model + system prompt（含 cache_control 位置/TTL）+ tools schema + betas header
```

### 5.2 支线任务路由不影响主线 Cache

Claude Code 的 LLM 调用分两类，cache 完全独立：

| 调用类型 | querySource | Cache 追踪 | Cache 策略 |
|---------|-------------|-----------|-----------|
| **主线**（主对话循环） | `repl_main_thread` / `sdk` / `agent:*` | 是，有 break 检测 | 有 `cache_control`，最长 1h TTL |
| **支线**（单次 sideQuery） | `hook_prompt` / `session_title` 等 | **否**（代码明确排除） | **无 cache_control**，不做 cache |

`promptCacheBreakDetection.ts` 中的 `getTrackingKey()` 只跟踪 `repl_main_thread` / `sdk` / `agent:custom` / `agent:default` / `agent:builtin`，其余 source 直接返回 `null`。支线任务本来就是独立的一次性请求，**把 model 切换到开源模型对主线 cache 完全透明**。

### 5.3 唯一风险：识别逻辑误判

如果 LiteLLM 的路由检测把主线任务（`repl_main_thread`）误判为支线任务并路由到开源模型，会同时触发：

- `modelChanged` → cache break（`promptCacheBreakDetection.ts:333`）
- 模型不兼容 → 输出质量下降

文章采用"至少匹配 3 个关键字"的阈值来避免误判，是合理的保守策略。

---

## 六、可用开源模型处理的 LLM 调用全景

从代码中枚举所有 `querySource`（`src` 全库统计），按适用性分三档：

### 第一档：强烈推荐（固定 JSON 输出 + 短上下文）

| querySource | 触发位置 | 任务描述 | 识别线索 |
|-------------|---------|---------|---------|
| `hook_prompt` | `execPromptHook.ts:84` | Prompt hook 条件评估 | system 含 `"You are evaluating a hook in Claude Code"` |
| `hook_agent` | `execAgentHook.ts:174` | Agent hook 验证（输出 `{ok: bool}`） | 同上，有 `StructuredOutputTool` 强制要求 |
| `bash_extract_prefix` | `bash/commands.ts:505` | Bash 命令前缀描述 | 输出极短，有固定格式 |
| `mcp_datetime_parse` | `mcp/dateTimeParser.ts:73` | MCP 日期时间格式转换 | 纯格式转换，无推理 |
| `model_validation` | `validateModel.ts:61` | 验证模型可用性（max_tokens=1） | 只需 1 token 响应 |
| `rename_generate_name` | `generateSessionName.ts:38` | 生成会话名称（≤5个词） | 输出极短，无代码上下文 |
| `generate_session_title` | `sessionTitle.ts:103` | 生成对话标题 | 同上 |
| `teleport_generate_title` | `teleport.tsx:128` | Teleport 功能标题生成 | 同上 |
| `memdir_relevance` | `findRelevantMemories.ts:121` | 给记忆片段打相关性分 | 输出为评分，格式固定 |

### 第二档：适合（短上下文 + 结构化输出，需验证质量）

| querySource | 触发位置 | 任务描述 | 注意点 |
|-------------|---------|---------|-------|
| `speculation` | `PromptSuggestion/speculation.ts` | 预测用户下一步输入 | 输出为候选 prompt 列表，影响 UX |
| `prompt_suggestion` | `promptSuggestion.ts:323` | 生成下一步建议 | 同上 |
| `permission_explainer` | `permissionExplainer.ts:185` | 解释权限请求原因 | 输出给用户看，需流畅自然语言 |
| `agent_summary` | `agentSummary.ts:115` | 汇总 SubAgent 执行结果 | 上下文较短，摘要质量影响决策 |
| `away_summary` | `awaySummary.ts:54` | 生成"离开"时的执行摘要 | 类似 agent_summary |
| `tool_use_summary_generation` | `toolUseSummaryGenerator.ts:74` | 生成工具调用摘要 | 输入输出都较短 |
| `session_memory` | `sessionMemory.ts` | 提取/存储会话记忆 | 结构化提取，准确性重要 |
| `extract_memories` | `extractMemories.ts:419` | 从对话中抽取记忆片段 | 同上 |
| `side_question` | `sideQuestion.ts:91` | 独立单轮问答 | 取决于问题复杂度 |

### 第三档：不建议（重推理 / 依赖 Claude 特有能力 / 安全相关）

| querySource | 原因 |
|-------------|------|
| `repl_main_thread` | 主对话，需完整推理 + Prompt Cache，**绝不路由** |
| `compact` | 压缩摘要影响后续对话，且与 main thread 共享 cache key |
| `auto_mode` / `auto_mode_critique` | 权限安全分类器（yolo classifier），误判有安全风险 |
| `verification_agent` | 验证 Plan 执行结果，判断错误代价高 |
| `insights` | 深度代码分析，需强推理 |
| `magic_docs` | 文档生成，质量要求高 |
| `auto_dream` | 自主探索任务，开放式推理 |

### 路由决策框架（扩展版）

```python
def _detect_task_type(self, text, messages):
    if self._is_hook_evaluator(text):
        return "sagemaker-kimi-2-5"       # hook 条件评估
    elif self._is_session_title_generator(text):
        return "sagemaker-kimi-2-5"       # 标题生成
    elif self._is_bash_description_writer(text):
        return "sagemaker-kimi-2-5"       # 命令描述
    elif self._is_structured_output_only(text):
        return "sagemaker-kimi-2-5"       # 纯 JSON 输出任务
    elif len(text) > 10000:
        return "bedrock-claude-sonnet46"  # 长上下文主线任务
    else:
        return None  # 保持原始模型
```

约 15–18 个 querySource 适合路由到开源模型，集中在"格式锁定类"（输出为固定 JSON/极短文本）和"摘要/提取类"（结构化提取）两类。

---

## 七、SubAgent 与 Agent Teams 的开源模型适用性

### 7.1 SubAgent 的 Model 决策链

来源：`src/utils/model/agent.ts`，5 级优先级：

```
1. CLAUDE_CODE_SUBAGENT_MODEL 环境变量  ← 最高优先级，覆盖一切
2. AgentTool 调用时传入的 model 参数
3. Agent 定义中的 model 字段
4. 'inherit'（默认）→ 继承父对话的 mainLoopModel
5. Plan 模式下自动升级 Opus → OpusPlan
```

文章配置中已用到：`CLAUDE_CODE_SUBAGENT_MODEL=bedrock-claude-sonnet45`，这是全局切换的最简路径（一行环境变量覆盖所有 SubAgent）。

### 7.2 SubAgent 的 Cache 独立性

SubAgent 的 cache **完全独立于主对话**：

- ✅ 独立的 system prompt（每种 agent 有自己的指令）
- ✅ 独立的 tool 列表（按 agent 类型过滤，`src/tools/AgentTool/agentToolUtils.ts`）
- ✅ 独立的 message history（从空开始，除非显式 fork context）
- ✅ 独立的 ReadFileState（克隆，不共享缓存）

因此**切换 SubAgent 的 model 不会影响主对话的 prompt cache**。

**唯一例外：Fork Agent**（`agent:builtin:fork`）。Fork agent 的设计目标就是共享父对话的 system prompt 和 tool 列表来命中同一 cache 前缀，路由到不同模型会直接导致 cache miss，**不可替换**。

### 7.3 内置 Agent 类型逐个评估

| Agent 类型 | querySource | 任务性质 | 能否用开源模型 |
|-----------|-------------|---------|-------------|
| `Explore` | `agent:builtin:Explore` | 只读搜索代码库（Glob/Grep/Read 工具组合） | ⚠️ 有条件可行 |
| `statusline-setup` | `agent:builtin:statusline-setup` | 配置 status line 格式，写一次配置文件 | ✅ 可行 |
| `claude-code-guide` | `agent:builtin:claude-code-guide` | 回答 Claude Code 使用问题，无复杂工具调用 | ⚠️ 有条件可行 |
| `verification_agent` | `verification_agent` | 验证 Plan 执行结果，输出 `{ok: bool}` | ⚠️ 有条件可行 |
| `Plan` | `agent:builtin:Plan` | 架构设计、方案规划 | ❌ 不建议 |
| `general-purpose` | `agent:custom` | 通用任务，复杂度不定 | ❌ 不建议 |
| Fork Agent | `agent:builtin:fork` | 共享父 cache 的并行子任务 | ❌ 绝对不能替换 |

### 7.4 为何 SubAgent 比支线任务更难替换

支线任务（sideQuery）与 SubAgent 有本质区别：

| 维度 | 支线任务（sideQuery） | SubAgent |
|------|---------------------|---------|
| 对话轮数 | 1 轮，单次 API 调用 | 多轮循环，直到任务完成 |
| 工具调用 | 无（或极少） | 完整工具集（读/写文件、Bash 等） |
| 错误容忍 | 格式错误顶多输出乱 | 工具调用格式错误 → 任务直接失败或破坏文件 |
| 上下文长度 | 通常 <2K tokens | 可能数十 K tokens，含整个代码库 |
| 开源模型风险 | 低 | 高（可能写坏代码、删错文件） |

**工具调用兼容性是最大障碍**。Claude Code 的工具 schema 包含复杂嵌套结构（如 `MultiEditTool`、`TodoWrite`），开源模型的 function calling 实现参差不齐，格式偏差会导致工具调用失败或产生错误操作。

### 7.5 Agent Teams（Swarm）特殊情况

In-process teammate 的额外限制（`src/utils/swarm/inProcessRunner.ts:981`）：

- **强制 `permissionMode: 'default'`**，获得比父代理更多的工具访问权，安全风险更高
- **注入团队通信工具**（`SendMessage`、`TeamCreate` 等），这些工具的交互协议开源模型不熟悉
- Teammate 任务由用户自定义，不像支线任务有固定 system prompt 可供 LiteLLM 识别

**建议**：Agent Teams 场景不通过 LiteLLM 层路由，改在 agent 定义的 `model` 字段里针对具体任务单独指定开源模型（如纯数据处理的 teammate），而不影响其他 teammate。

### 7.6 SubAgent 实操建议

```bash
# 方案 A：全局设置 SubAgent 用更快但较弱的模型（适合 Explore/verify 等只读类）
export CLAUDE_CODE_SUBAGENT_MODEL=bedrock-claude-haiku45

# 方案 B：在 agent 定义中针对特定 agent 类型单独指定（精细控制）
# statusline-setup / claude-code-guide → 可指定开源模型
# Plan / general-purpose → 保持 Claude Sonnet
```

**明确不能替换的**：
- Fork agent（破坏 cache）
- `Plan` agent（质量直接影响整个任务的执行方向）
- 带文件写入的 `general-purpose` agent

**核心结论**：SubAgent 路由在技术上完全可行，但**实际收益远低于支线任务路由**——错误代价高（会真实修改代码文件），而支线任务的错误代价低（顶多标题生成不好看）。优先选择只读型、输出格式固定型的 agent 进行验证后再扩大范围。

---

## 八、方案局限与注意事项

1. **识别准确性**：关键字匹配可能随 Claude Code 版本更新而失效（system prompt 变动）。建议在灰度环境先验证识别逻辑，再上生产。

2. **开源模型 JSON 能力**：hook 条件评估等任务虽然简单，但如果开源模型的 JSON 格式能力不足，可能导致 `{"ok": ...}` 解析失败，进而影响 hook 的正常执行。

3. **Streaming Schema 兼容性**：`async_post_call_streaming_iterator_hook` 是 LiteLLM 的扩展点，需确认所用 LiteLLM 版本支持（文章使用 `v1.82.3-stable`）。SubAgent 同样走 streaming 路径，也需要 `stream_anthropic_schema_fixer`。

4. **混合路由不等于完全私有化**：主线任务仍走 Bedrock（外部），仅支线任务在 VPC 内处理。若需"代码零出境"，主线也需路由到 SageMaker，但会损失复杂推理能力。

5. **SubAgent 工具调用兼容性**：开源模型对 Claude Code 工具 schema 的支持参差不齐，在生产环境替换 SubAgent 前需充分测试工具调用的格式稳定性。

---

## 九、相关代码位置

| 文件 | 说明 |
|------|------|
| `src/entrypoints/sdk/coreTypes.ts:25` | 所有 hook 事件名称常量 |
| `src/schemas/hooks.ts` | hook 类型 schema（command/prompt/agent/http） |
| `src/types/hooks.ts` | hook 返回值 schema + TypeScript 类型 |
| `src/utils/hooks.ts` | hook 执行引擎（`runHook` / `runHooks` / `aggregateHookResults`） |
| `src/utils/hooks/hookEvents.ts` | hook 执行进度事件广播系统 |
| `src/utils/hooks/hooksSettings.ts` | hook 配置读取、来源枚举（`getAllHooks`） |
| `src/utils/hooks/hookHelpers.ts` | prompt/agent hook 公共工具（`addArgumentsToPrompt` / `createStructuredOutputTool`） |
| `src/utils/hooks/execPromptHook.ts` | prompt hook 执行逻辑（调用 LLM 评估） |
| `src/utils/hooks/execAgentHook.ts` | agent hook 执行逻辑（启动子 agent） |
| `src/utils/hooks/execHttpHook.ts` | HTTP hook 执行逻辑 |
| `src/services/api/promptCacheBreakDetection.ts` | Prompt Cache break 检测与追踪 |
| `src/utils/sideQuery.ts` | 支线 LLM 调用统一入口 |
| `src/utils/model/agent.ts` | SubAgent model 决策链（5 级优先级） |
| `src/tools/AgentTool/runAgent.ts` | SubAgent 执行入口，system prompt / tool 构建 |
| `src/tools/AgentTool/agentToolUtils.ts` | SubAgent tool 列表过滤逻辑 |
| `src/utils/swarm/inProcessRunner.ts` | Agent Teams in-process runner |
