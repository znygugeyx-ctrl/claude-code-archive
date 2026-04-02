# 功能同步状态

> 本文件追踪官方 Claude Code 版本与本地实现的差距。由 `/sync-upstream` skill 维护。

上次检查: 2026-04-02 | 官方最新: 2.1.90 | 本地基线: 2.1.87

状态图例: ✅ 已实现 | ⚠️ 部分实现 | ❌ 未实现 | ➖ 不适用
优先级: 🔴 高 | 🟡 中 | 🟢 低

---

## 2.1.90

### 🔴 高优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Fixed | `--resume` causing a full prompt-cache miss on first request for users with deferred tools, MCP servers, or custom agents (regression since v2.1.69) | ❌ | |
| Fixed | `Edit`/`Write` failing with "File content has changed" when a PostToolUse format-on-save hook rewrites the file between consecutive edits | ❌ | |
| Fixed | `PreToolUse` hooks that emit JSON to stdout and exit with code 2 not correctly blocking the tool call | ❌ | |
| Fixed | UI crash when malformed tool input reached the permission dialog | ❌ | |
| Improved | Performance: eliminated per-turn JSON.stringify of MCP tool schemas on cache-key lookup | ❌ | |
| Improved | Performance: SDK sessions with long conversations no longer slow down quadratically on transcript writes | ❌ | |
| Changed | `--resume` picker no longer shows sessions created by `claude -p` or SDK invocations | ❌ | |

### 🟡 中优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | `/powerup` — interactive lessons teaching Claude Code features with animated demos | ❌ | |
| Added | `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE` env var — keeps existing marketplace cache when `git pull` fails (offline environments) | ❌ | |
| Added | `.husky` to protected directories (acceptEdits mode) | ❌ | |
| Fixed | Infinite loop where rate-limit options dialog would repeatedly auto-open after hitting usage limit, eventually crashing the session | ❌ | |
| Fixed | Auto mode not respecting explicit user boundaries ("don't push", "wait for X before Y") even when action would otherwise be allowed | ❌ | |
| Improved | Performance: SSE transport now handles large streamed frames in linear time (was quadratic) | ❌ | |
| Improved | `/resume` all-projects view loads project sessions in parallel, improving load times for users with many projects | ❌ | |

### 🟢 低优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Fixed | Collapsed search/read summary badge appearing multiple times in fullscreen scrollback when a CLAUDE.md file auto-loads during a tool call | ❌ | |
| Fixed | Click-to-expand hover text being nearly invisible on light terminal themes | ❌ | |
| Fixed | Headers disappearing when scrolling `/model`, `/config`, and other selection screens | ❌ | |

### ➖ 不适用

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Fixed | Hardened PowerShell tool permission checks: fixed trailing `&` background job bypass, `-ErrorAction Break` debugger hang, archive-extraction TOCTOU, and parse-fail fallback deny-rule degradation | ➖ | Windows 专属 |
| Removed | `Get-DnsClientCache` and `ipconfig /displaydns` from auto-allow (DNS cache privacy) | ➖ | Windows 专属 |

## 2.1.89

### 🔴 高优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | `"defer"` permission decision to PreToolUse hooks — headless sessions pause at tool call, resume with `-p --resume` | ❌ | 当前只有 allow/deny/ask，缺少 defer |
| Added | `PermissionDenied` hook — fires after auto mode classifier denials, return `{retry: true}` to retry | ✅ | hooks.ts:3529 executePermissionDeniedHooks() |
| Added | Named subagents to `@` mention typeahead suggestions | ✅ | SendMessageTool.ts:800 路由 + state/selectors named_agent |
| Added | `MCP_CONNECTION_NONBLOCKING=true` for `-p` mode to skip MCP connection wait | ❌ | 未找到任何相关实现 |
| Fixed | `Edit(//path/**)` and `Read(//path/**)` allow rules check resolved symlink target | ✅ | permissions/filesystem.ts:614+ 完整实现 |
| Fixed | `-p --resume` hangs when deferred tool input exceeds 64KB or no deferred marker | ✅ | resume + deferred tools 基础设施已实现 |
| Fixed | MCP tool errors truncating to only first content block for multi-element error content | ✅ | mcpValidation.ts:84 + mcp/client.ts |
| Fixed | Skill reminders and system context dropped when sending messages with images via SDK | ❌ | 有 skill reminder 注入但无 image 条件处理 |
| Fixed | PreToolUse/PostToolUse hooks receive `file_path` as absolute path for Write/Edit/Read tools | ✅ | FileWriteTool.ts:126 expandPath() |
| Fixed | Hooks `if` condition filtering not matching compound commands (`ls && git push`) | ⚠️ | hooks.ts:1383 有 if 条件但只支持单 pattern，不支持复合命令 |
| Fixed | OOM crash when Edit tool used on files >1 GiB | ✅ | FileEditTool.ts:84 MAX_EDIT_FILE_SIZE = 1GiB |
| Improved | Bash tool warns when formatter/linter modifies previously read files | ❌ | 无此警告机制 |
| Changed | `Edit` works on files viewed via `Bash` with `sed -n` or `cat`, no separate `Read` needed | ⚠️ | BashTool 仅注册 sed -i 的 readState，不含 cat/head 查看 |
| Changed | Hook output over 50K chars saved to disk with file path + preview | ❌ | 当前截断在 10K，无磁盘保存机制 |
| Documented | `TaskCreated` hook event and its blocking behavior | ✅ | hooks.ts:3745 + TaskCreateTool.ts:93 完整实现 |

### 🟡 中优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Other | Auto mode: denied commands show notification, appear in `/permissions` → Recent tab | ❌ | |
| Fixed | `StructuredOutput` schema cache bug causing ~50% failure rate with multiple schemas | ❌ | |
| Fixed | Memory leak — large JSON inputs retained as LRU cache keys in long sessions | ❌ | |
| Fixed | Crash when removing message from very large session files (>50MB) | ❌ | |
| Fixed | LSP server zombie state after crash — now restarts on next request | ❌ | |
| Fixed | Prompt history entries with CJK/emoji dropped on 4KB boundary in history.jsonl | ❌ | |
| Fixed | `/stats` undercounting tokens by excluding subagent usage | ❌ | |
| Fixed | Autocompact thrash loop — detects 3 consecutive refills and stops with error | ❌ | |
| Fixed | Prompt cache misses caused by tool schema bytes changing mid-session | ❌ | |
| Fixed | Nested CLAUDE.md files re-injected dozens of times in long sessions | ❌ | |
| Fixed | `--resume` crash when transcript contains tool_result from older CLI version | ❌ | |
| Fixed | Misleading "Rate limit reached" when API returned entitlement error | ❌ | |
| Improved | `@`-mention typeahead ranks source files above MCP resources with similar names | ❌ | |
| Changed | `cleanupPeriodDays: 0` rejected with validation error | ❌ | |
| Changed | Thinking summaries no longer generated by default — set `showThinkingSummaries: true` to restore | ❌ | |
| Other | Preserved task notifications when backgrounding a running command with Ctrl+B | ❌ | |

### 🟢 低优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | `CLAUDE_CODE_NO_FLICKER=1` env var for flicker-free alt-screen rendering | ❌ | |
| Fixed | `claude-cli://` deep links not opening on macOS | ❌ | |
| Fixed | Collapsed search/read group badges duplicating in terminal scrollback | ❌ | |
| Fixed | Notification `invalidates` not clearing currently-displayed notification | ❌ | |
| Fixed | Prompt briefly disappearing after submit when background messages arrive | ❌ | |
| Fixed | Devanagari and combining-mark text truncated in assistant output | ❌ | |
| Fixed | Rendering artifacts on main-screen terminals after layout shifts | ❌ | |
| Fixed | Periodic UI jitter during streaming in iTerm2 inside tmux | ❌ | |
| Improved | Collapsed tool summary shows "Listed N directories" for ls/tree/du | ❌ | |
| Other | `/usage` hides redundant "Current week (Sonnet only)" bar for Pro/Enterprise | ❌ | |
| Other | Image paste no longer inserts trailing space | ❌ | |
| Other | Pasting `!command` into empty prompt enters bash mode | ❌ | |

### ➖ 不适用

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Fixed | Voice push-to-talk not activating; voice mode on Windows WebSocket 101 | ➖ | voice/Windows 特定 |
| Fixed | Edit/Write tools doubling CRLF on Windows, stripping Markdown hard line breaks | ➖ | Windows 特定 |
| Fixed | Voice mode failing to request microphone permission on macOS Apple Silicon | ➖ | voice 特定 |
| Fixed | Shift+Enter submitting instead of inserting newline on Windows Terminal Preview 1.25 | ➖ | Windows 特定 |
| Fixed | PowerShell tool reporting failures when git push wrote to stderr on PS 5.1 | ➖ | PowerShell 特定 |
| Improved | PowerShell tool prompt with version-appropriate syntax guidance (5.1 vs 7+) | ➖ | PowerShell 特定 |
| Other | PowerShell argument hardening (double-quote + whitespace prompt) | ➖ | PowerShell 特定 |
| Other | `/env` now applies to PowerShell tool commands | ➖ | PowerShell 特定 |
| Other | `/buddy` — April 1st Easter egg | ➖ | 彩蛋 |
