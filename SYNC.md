# 功能同步状态

> 本文件追踪官方 Claude Code 版本与本地实现的差距。由 `/sync-upstream` skill 维护。

上次检查: 2026-04-09 | 官方最新: 2.1.97 | 本地基线: 2.1.87

状态图例: ✅ 已实现 | ⚠️ 部分实现 | ❌ 未实现 | ➖ 不适用
优先级: 🔴 高 | 🟡 中 | 🟢 低

---

## 2.1.97

### 🔴 高优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | `workspace.git_worktree` to the status line JSON input, set when the current directory is inside a linked git worktree | ❌ | |
| Added | `● N running` indicator in `/agents` next to agent types with live subagent instances | ❌ | |
| Fixed | `--dangerously-skip-permissions` being silently downgraded to accept-edits mode after approving a write to a protected path | ❌ | |
| Fixed | Bash tool permissions hardened: tightened env-var prefix checks and network redirect handling, reduced false prompts on common commands | ❌ | |
| Fixed | Permission rules with names matching JavaScript prototype properties (e.g. `toString`) causing `settings.json` to be silently ignored | ❌ | |
| Fixed | `permissions.additionalDirectories` changes in settings not applying mid-session | ❌ | |
| Fixed | Removing a directory from `settings.permissions.additionalDirectories` revoking access to the same directory passed via `--add-dir` | ❌ | |
| Fixed | MCP HTTP/SSE connections accumulating ~50 MB/hr of unreleased buffers when servers reconnect | ❌ | |
| Fixed | MCP OAuth `oauth.authServerMetadataUrl` not being honored on token refresh after restart, fixing ADFS and similar IdPs | ❌ | |
| Fixed | Prompt-type `Stop`/`SubagentStop` hooks failing on long sessions; hook evaluator API errors now show actual message instead of "JSON validation failed" | ❌ | |
| Fixed | Subagents with worktree isolation or `cwd:` override leaking their working directory back to the parent session's Bash tool | ❌ | |
| Fixed | Compaction writing duplicate multi-MB subagent transcript files on prompt-too-long retries | ❌ | |
| Fixed | Crash in `NO_FLICKER` mode when hovering over MCP tool results | ❌ | |
| Fixed | `NO_FLICKER` mode memory leak where API retries left stale streaming state | ❌ | |
| Improved | Auto mode and bypass-permissions mode now auto-approve sandbox network access prompts | ❌ | |
| Improved | Image handling: pasted and attached images compressed to same token budget as images read via Read tool | ❌ | |
| Improved | Session transcript size: skips empty hook entries and caps stored pre-edit file copies | ❌ | |
| Improved | Bash tool OTEL tracing: subprocesses inherit a W3C `TRACEPARENT` env var when tracing is enabled | ❌ | |
| Updated | `/claude-api` skill to cover Managed Agents alongside the Claude API | ❌ | |

### 🟡 中优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | `refreshInterval` status line setting to re-run the status line command every N seconds | ❌ | |
| Added | Syntax highlighting for Cedar policy files (`.cedar`, `.cedarpolicy`) | ❌ | |
| Fixed | Managed-settings allow rules remaining active after an admin removed them until process restart | ❌ | |
| Fixed | 429 retries burning all attempts in ~13 seconds when server returns small `Retry-After` — exponential backoff now applies as minimum | ❌ | |
| Fixed | Rate-limit upgrade options disappearing after context compaction | ❌ | |
| Fixed | Several `/resume` picker issues: `--resume <name>` opening uneditable, Ctrl+A reload wiping search, empty list swallowing navigation, task-status text replacing conversation summary, cross-project staleness | ❌ | |
| Fixed | File-edit diffs disappearing on `--resume` when edited file was larger than 10KB | ❌ | |
| Fixed | `--resume` cache misses and lost mid-turn input from attachment messages not being saved to transcript | ❌ | |
| Fixed | Messages typed while Claude is working not being persisted to transcript | ❌ | |
| Fixed | `claude plugin update` reporting "already at latest version" for git-based marketplace plugins when remote had newer commits | ❌ | |
| Fixed | Slash command picker breaking when a plugin's frontmatter `name` is a YAML boolean keyword | ❌ | |
| Fixed | Bedrock SigV4 authentication failing when `AWS_BEARER_TOKEN_BEDROCK` or `ANTHROPIC_BEDROCK_BASE_URL` are set to empty strings | ❌ | |
| Improved | Accept Edits mode auto-approves filesystem commands prefixed with safe env vars or process wrappers (e.g. `LANG=C rm foo`, `timeout 5 mkdir out`) | ❌ | |
| Improved | `sandbox.network.allowMachLookup` now takes effect on macOS | ❌ | |
| Improved | Slash command and `@`-mention completion triggers after CJK sentence punctuation | ❌ | |
| Improved | Bridge sessions show local git repo, branch, and working directory on claude.ai session card | ❌ | |
| Improved | Transcript accuracy: per-block entries carry final token usage instead of streaming placeholder | ❌ | |

### 🟢 低优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | Focus view toggle (`Ctrl+O`) in `NO_FLICKER` mode showing prompt, one-line tool summary with edit diffstats, and final response | ❌ | |
| Fixed | Copying wrapped URLs in `NO_FLICKER` mode inserting spaces at line breaks | ❌ | |
| Fixed | Scroll rendering artifacts in `NO_FLICKER` mode when running inside zellij | ❌ | |
| Fixed | Custom status line not displaying in `NO_FLICKER` mode on terminals shorter than 24 rows | ❌ | |
| Fixed | Shift+Enter and Alt/Cmd+arrow shortcuts not working in Warp with `NO_FLICKER` mode | ❌ | |
| Improved | Footer layout: indicators (Focus, notifications) now stay on mode-indicator row instead of wrapping below | ❌ | |
| Improved | Context-low warning shows as transient footer notification instead of persistent row | ❌ | |
| Improved | Markdown blockquotes show a continuous left bar across wrapped lines | ❌ | |

### ➖ 不适用

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Fixed | Slow mouse-wheel scrolling in `NO_FLICKER` mode on Windows Terminal | ➖ | Windows 专属 |
| Fixed | Korean/Japanese/Unicode text becoming garbled when copied in no-flicker mode on Windows | ➖ | Windows 专属 |

## 2.1.96

### 🟡 中优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Fixed | Bedrock requests failing with `403 "Authorization header is missing"` when using `AWS_BEARER_TOKEN_BEDROCK` or `CLAUDE_CODE_SKIP_BEDROCK_AUTH` (regression in 2.1.94) | ❌ | |

## 2.1.94

### 🔴 高优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Changed | Default effort level changed from medium to high for API-key, Bedrock/Vertex/Foundry, Team, and Enterprise users (control via `/effort`) | ❌ | |
| Added | `hookSpecificOutput.sessionTitle` to `UserPromptSubmit` hooks for setting the session title | ❌ | |
| Fixed | Agents appearing stuck after a 429 rate-limit response with a long Retry-After header — error now surfaces immediately | ❌ | |
| Fixed | Plugin skill hooks defined in YAML frontmatter being silently ignored | ❌ | |
| Fixed | Bedrock invocation of Sonnet 3.5 v2 by using the `us.` inference profile ID | ❌ | |
| Fixed | SDK/print mode not preserving the partial assistant response in conversation history when interrupted mid-stream | ❌ | |
| Improved | `--resume` now resumes sessions from other worktrees of the same repo directly instead of printing a `cd` command | ❌ | |

### 🟡 中优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | Support for Amazon Bedrock powered by Mantle, set `CLAUDE_CODE_USE_MANTLE=1` | ❌ | |
| Added | `keep-coding-instructions` frontmatter field support for plugin output styles | ❌ | |
| Changed | Plugin skills declared via `"skills": ["./"]` now use the skill's frontmatter `name` for invocation name instead of directory basename | ❌ | |
| Fixed | Console login on macOS silently failing with "Not logged in" when login keychain is locked or password out of sync | ❌ | |
| Fixed | Plugin hooks failing with "No such file or directory" when `CLAUDE_PLUGIN_ROOT` was not set | ❌ | |
| Fixed | `${CLAUDE_PLUGIN_ROOT}` resolving to marketplace source directory instead of installed cache for local-marketplace plugins on startup | ❌ | |
| Fixed | `FORCE_HYPERLINK` environment variable being ignored when set via `settings.json` `env` | ❌ | |
| Fixed | CJK and other multibyte text being corrupted with U+FFFD in stream-json input/output when chunk boundaries split a UTF-8 sequence | ❌ | |

### 🟢 低优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | Compact `Slacked #channel` header with clickable channel link for Slack MCP send-message tool calls | ❌ | |
| Fixed | Scrollback showing the same diff repeated and blank pages in long-running sessions | ❌ | |
| Fixed | Multiline user prompts in the transcript indenting wrapped lines under the `❯` caret instead of under the text | ❌ | |
| Fixed | Shift+Space inserting the literal word "space" instead of a space character in search inputs | ❌ | |
| Fixed | Hyperlinks opening two browser tabs when clicked inside tmux running in an xterm.js-based terminal (VS Code, Hyper, Tabby) | ❌ | |
| Fixed | Alt-screen rendering bug where content height changes mid-scroll could leave compounding ghost lines | ❌ | |
| Fixed | Native terminal cursor not tracking the selected tab in dialogs, so screen readers and magnifiers can follow tab navigation | ❌ | |

### ➖ 不适用

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Fixed | [VSCode] Reduced cold-open subprocess work on starting a session | ➖ | VSCode 专属 |
| Fixed | [VSCode] Dropdown menus selecting the wrong item when mouse was over the list while typing or using arrow keys | ➖ | VSCode 专属 |
| Added | [VSCode] Warning banner when `settings.json` files fail to parse | ➖ | VSCode 专属 |

## 2.1.92

### 🔴 高优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | Per-model and cache-hit breakdown to `/cost` for subscription users | ❌ | model 相关 |
| Fixed | Subagent spawning permanently failing with "Could not determine pane count" after tmux windows are killed or renumbered | ❌ | subagent |
| Fixed | Prompt-type Stop hooks incorrectly failing when the small fast model returns `ok:false`; restored `preventContinuation:true` semantics for non-Stop prompt-type hooks | ❌ | hook |
| Fixed | Tool input validation failures when streaming emits array/object fields as JSON-encoded strings | ❌ | tool |
| Fixed | API 400 error that could occur when extended thinking produced a whitespace-only text block alongside real content | ❌ | API |
| Fixed | Plugin MCP servers stuck "connecting" on session start when they duplicate a claude.ai connector that is unauthenticated | ❌ | MCP |
| Improved | Write tool diff computation speed for large files (60% faster on files with tabs/`&`/`$`) | ❌ | tool |

### 🟡 中优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | `forceRemoteSettingsRefresh` policy setting: blocks startup until remote managed settings are freshly fetched, exits if fetch fails | ❌ | |
| Added | Interactive Bedrock setup wizard from login screen when selecting "3rd-party platform" | ❌ | |
| Changed | Remote Control session names use hostname as default prefix (e.g. `myhost-graceful-unicorn`), overridable with `--remote-control-session-name-prefix` | ❌ | |
| Removed | `/tag` command | ❌ | |
| Removed | `/vim` command (toggle vim mode via `/config` → Editor mode) | ❌ | |
| Added | Linux sandbox ships `apply-seccomp` helper in both npm and native builds, restoring unix-socket blocking for sandboxed commands | ❌ | |

### 🟢 低优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Changed | `/release-notes` is now an interactive version picker | ❌ | |
| Added | Pro users see footer hint when returning to session after prompt cache expires | ❌ | |
| Fixed | Accidental feedback survey submissions from auto-pilot keypresses and consecutive-prompt digit collisions | ❌ | |
| Fixed | Misleading "esc to interrupt" hint appearing alongside "esc to clear" when text selection exists in fullscreen mode | ❌ | |
| Fixed | Homebrew install update prompts to use correct release channel (`claude-code` → stable, `claude-code@latest` → latest) | ❌ | |
| Fixed | `ctrl+e` jumping to end of next line when already at end of line in multiline prompts | ❌ | |
| Fixed | Same message appearing at two positions when scrolling up in fullscreen mode (iTerm2, Ghostty, DEC 2026 terminals) | ❌ | scroll |
| Fixed | Idle-return "/clear to save X tokens" hint showing cumulative session tokens instead of current context size | ❌ | |

## 2.1.91

### 🔴 高优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | MCP tool result persistence override via `_meta["anthropic/maxResultSizeChars"]` annotation (up to 500K) | ❌ | MCP |
| Changed | Plugins can now ship executables under `bin/` and invoke them as bare commands from the Bash tool | ❌ | tool |
| Fixed | JSON schema validation for `permissions.defaultMode: "auto"` in settings.json | ❌ | permission |
| Improved | `/claude-api` skill guidance for agent design patterns including tool surface decisions, context management, and caching strategy | ❌ | SDK, agent |
| Improved | Edit tool now uses shorter `old_string` anchors, reducing output tokens | ❌ | tool |

### 🟡 中优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | `disableSkillShellExecution` setting to disable inline shell execution in skills, custom slash commands, and plugin commands | ❌ | |
| Fixed | Transcript chain breaks on `--resume` that could lose conversation history when async transcript writes fail silently | ❌ | |
| Fixed | Plan mode in remote sessions losing track of plan file after container restart | ❌ | |

### 🟢 低优先级

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Added | Support for multi-line prompts in `claude-cli://open?q=` deep links (encoded newlines `%0A` no longer rejected) | ❌ | deep link |
| Fixed | `cmd+delete` not deleting to start of line on iTerm2, kitty, WezTerm, Ghostty, and Windows Terminal | ❌ | |
| Changed | `/feedback` now explains why it's unavailable instead of disappearing from the slash menu | ❌ | |
| Improved | Performance: faster `stripAnsi` on Bun by routing through `Bun.stripANSI` | ❌ | |

### ➖ 不适用

| 类型 | 描述 | 状态 | 备注 |
|------|------|------|------|
| Fixed | Windows version cleanup not protecting the active version's rollback copy | ➖ | Windows 专属 |

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
| Added | `PermissionDenied` hook — fires after auto mode classifier denials, return `{retry: true}` to retry | ❌ | |
| Added | Named subagents to `@` mention typeahead suggestions | ❌ | |
| Added | `MCP_CONNECTION_NONBLOCKING=true` for `-p` mode to skip MCP connection wait | ❌ | |
| Fixed | `Edit(//path/**)` and `Read(//path/**)` allow rules check resolved symlink target | ❌ | |
| Fixed | `-p --resume` hangs when deferred tool input exceeds 64KB or no deferred marker | ❌ | |
| Fixed | MCP tool errors truncating to only first content block for multi-element error content | ❌ | |
| Fixed | Skill reminders and system context dropped when sending messages with images via SDK | ❌ | |
| Fixed | PreToolUse/PostToolUse hooks receive `file_path` as absolute path for Write/Edit/Read tools | ❌ | |
| Fixed | Hooks `if` condition filtering not matching compound commands (`ls && git push`) | ❌ | |
| Fixed | OOM crash when Edit tool used on files >1 GiB | ❌ | |
| Improved | Bash tool warns when formatter/linter modifies previously read files | ❌ | |
| Changed | `Edit` works on files viewed via `Bash` with `sed -n` or `cat`, no separate `Read` needed | ❌ | |
| Changed | Hook output over 50K chars saved to disk with file path + preview | ❌ | |
| Documented | `TaskCreated` hook event and its blocking behavior | ❌ | |

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
| Fixed | Autocompact thrash loop — detects 3 consecutive refills and stops with error | ✅ | `consecutiveRefills` circuit breaker in `autoCompact.ts` + `query.ts` |
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
| Other | `/buddy` — April 1st Easter egg | ✅ | 彩蛋，本 fork 主动实现 |
