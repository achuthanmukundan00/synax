# Changelog

## [Unreleased]

### Breaking

- **Read results are now budgeted and truncated.** Previously "dogfooding mode" passed through all read output untruncated. Read results are now subject to a per-read token cap (with continuation guidance via `startLine`) and a per-turn cumulative cap, after which further reads are refused with a recoverable policy error. This keeps context from being swamped by large reads.
- **`maxToolCalls` and `maxModelSteps` are now enforced.** Previously both were set to `Number.MAX_SAFE_INTEGER` (effectively unlimited). Defaults are now `maxToolCalls=192`, `maxModelSteps=64`. Runaway loops now hit a hard stop with `budget_exhausted`.
- **Bash is now enabled by default.** Previously disabled-by-default. The docs and `[tools.bash]` behavior are updated accordingly. Disable via `[tools.bash] enabled = false`.

### Added

- **Mixed output handling (prose + tool calls).** Local models that mix prose and tool calls in one response are no longer treated as fatal errors. Unsafe prose is stripped and tool calls execute normally. The stored assistant message is replaced (not duplicated) to avoid breaking strict providers.
- **Truncation guard (`finish_reason=length`).** When a model response is cut off by the output token limit, tool calls from that response are NOT executed (arguments may be truncated). A continuation nudge is injected so the model can recover. Three consecutive truncations abort the turn as `model_error`.
- **Better argument name aliasing for local models.** `edit`/`replace_in_file` now accept `file`, `filePath`, `old_str`, `oldText`, `old_text`, `search`, `original`, `new_str`, `newText`, `new_text`, `replacement`, `replace`. `write`/`create_file` accept `file`, `filePath`, `text`, `contents`, `body`. This lets local models that use Python-style names self-correct without failing.
- **Actionable argument errors.** When a known tool receives wrong argument names, the error message lists the expected names so the model can self-correct on the next step.
- **True unified diffs in patch previews.** `createUnifiedDiff` now produces proper LCS-based line-level diffs with context lines (`@@ -a,b +c,d @@` headers), common prefix/suffix trimming, and elision of long unchanged runs. Falls back to whole-region replace for very large inputs. Previously all lines were dumped with `-`/`+` prefixes.
- **Sub-agent orchestration is opt-in.** Sub-agents are disabled by default (`config.subagents.enabled`). When disabled, the entire planner pipeline is skipped and tasks run inline — keeping the common single-agent path fast and cheap. Explicit in-task delegation requests ("use parallel sub-agents…") override the default.
- **Overlapping file-scope safety for parallel orchestration.** Forced-parallel mode is downgraded to sequential when sub-task file scopes overlap, preventing concurrent mutations from corrupting each other. Read-only plans (e.g. repo recon) keep their parallelism.
- **Informational task detection.** Tasks like "explain X" or "why does Y fail?" are detected as informational, relaxing the `files_changed` verification contract so the model isn't pushed into making spurious edits just to satisfy the contract.
- **Read cache invalidation on mutation.** After any successful `edit`, `write`, or `bash` call, the read cache is cleared so subsequent reads return fresh content — preventing stale-read→edit mismatch loops.
- **Repo overhead budget cap.** Repo overhead in budget estimation is capped at 40% of the effective context window, preventing large repos from over-triggering orchestration for small tasks.
- **System message role fix for local chat templates.** Mid-conversation system messages (orientation, memory index, compaction notes) are converted to `user` role with a `[system context]` prefix, preventing ChatML variants from dropping them or resetting the conversation.
- **TUI: tool result truncation with expand/collapse.** Long tool results (60+ lines) are truncated with an expand indicator (`▸ N more lines (Enter to expand)`). Pressing `Enter` on an empty prompt expands the most recent truncated card; `Ctrl+E` toggles all expandable cards; `e` (empty prompt) toggles the latest card.
- **TUI: Ctrl+C "press again to quit" hint.** First Ctrl+C shows the hint in the status bar; it clears after a timeout if no second Ctrl+C arrives.
- **TUI: autocomplete solid background.** The slash-autocomplete dropdown now has a solid surface background so the transcript doesn't bleed through.
- **TUI: settings overlay uses app background.** Settings screen rows use the app background color (not surface) so the overlay blends with the rest of the TUI instead of painting the terminal a solid grey block.
- **TUI: renderer theme alignment.** The renderer's clear color is aligned with the resolved palette, preventing a hardcoded dark background from clashing with light terminal themes (e.g. Ghostty light mode).
- **TUI: animation timer tracking.** Animation timers are tracked and cancelled on shutdown / re-render to prevent timer leaks.
- **TUI: `Ctrl+E` expand all.** Toggles all expandable tool result cards at once.
- **TUI: thinking cards always show full text.** Thinking blocks no longer collapse/expand — they're always fully visible and naturally scrollable.
- **TUI: resume picker restores sessions in-process.** Selecting `/resume` now loads only the chosen session's JSONL transcript, rebuilds model-visible user/assistant context behind the stable system/skill prefix for prompt-cache friendliness, and leaves the picker list backed by lightweight session-index metadata.
- **TUI: resume picker metadata.** The picker now renders message count, status, and model from the session index, and session search includes provider names.

### Changed

- **Thinking tags (`<think>`/`<thinking>`) are stripped from stored content.** Echoing thinking tags back into conversation history wastes context and degrades multi-step behavior (Qwen's own guidance recommends stripping). Reasoning is preserved in `reasoningContent` separately, which also powers the think-only fallback (bug #114).
- **`temperature` defaults to 0.2.** Previously `temperature` was only sent when explicitly configured. Now defaults to 0.2 for all requests.
- **`stream_options.include_usage` enabled.** Streaming requests now request usage data from providers that support it.
- **Non-streaming tool call fallback.** When a stream degrades to a non-streaming response, native `tool_calls` from the response are captured.
- **Better tool call delta indexing.** Delta fragments are indexed by `delta.index`, matched by `delta.id` (for providers that repeat ids), or appended to the most recent entry — fixing fragmented arguments across separate tool call entries.
- **Bash execution environment increased.** `maxBuffer` raised to 2MB (was 256KB), `timeout` raised to 120s (was 30s) — letting longer builds and tests complete.
- **Verification timeout increased.** Non-full verification profiles now get 60s timeout (was 30s).
- **Recon sub-tasks are read-only.** Repo recon sub-tasks now use `verification: { level: 'none' }` instead of `files_changed`.
- **"use agents" regex excludes "use the agents.md".** The `AGENTS.md` file reference no longer triggers sub-agent delegation.
- **Repo recon intent excludes mutation tasks.** Tasks containing mutation verbs (fix, change, edit, write, etc.) are no longer hijacked into repo recon mode.
- **Preflight budget guard uses assembled request.** Token estimation before model calls now uses the fully assembled request (with orientation, memory index) instead of raw conversation messages, producing accurate budget checks.
- **TUI: sticky scroll behavior.** The ScrollBox's built-in `_hasManualScroll` handles pause/recovery without disabling `stickyScroll` entirely — scrolling back to the bottom auto-resumes following.
- **TUI: thinking state reset.** Thinking state clears on `task_started` and `user_message` events, preventing thinking blocks from appending across turns.
- **TUI: autocomplete draft cleared on non-slash input.** Prevents deadlocked input submission after backspacing past `/`.
- **TUI: settings text input accepts all printable characters.** Model names, URLs, and API keys with `:`, `_`, `-`, uppercase, etc. now work correctly in the settings panel.
- **CI/CD: deploy to Cloudflare Pages.** Docs deployment in GitHub Actions now uses `cloudflare/wrangler-action` instead of GitHub Pages.
- **Remember: system prompt instructs model to verify changes, plan before acting, and read files before editing.** Three new directives added to the system prompt.

### Fixed

- **Read cache nudges no longer mutate cached objects.** Shallow copies prevent "already read" guidance from sticking to future cache hits.
- **Orchestration: `shouldOrchestrate` compares to `'orchestrate'` (not `'orchestrated'`).** Fixed a mismatch that caused orchestration to never be triggered by budget estimation.
- **Orchestration: `totalKB` used directly instead of formatting `Math.ceil(...)` as a string.** The plan prompt now contains a numeric value.
- **Recovery: `skipTaskPush` prevents duplicate user messages.** Recovery re-entry no longer pushes the task again — the recovery manager already injected a nudge.
- **TUI: `footerLayoutHeight` accounts for slash info lines.** Slash-command info panels no longer overlap with the input.
- **TUI: theme detection falls through on null.** When the terminal doesn't answer the OSC theme query, falls through to `COLORFGBG` instead of treating null as a concrete answer.
- **TUI: `rootLayoutModeSignature` drops `prompt.length` from compact detection.** Having text in the prompt no longer forces a full UI tree rebuild — only event count, settings, and slash info matter.
- **TUI: slash completion acceptance.** Slash-command completions are tagged separately from file/model completions, so pressing Enter on `/resume` or another slash command dispatches it instead of merely inserting text into the prompt.
- **TUI: resume picker search input.** Typing while the resume picker is open filters sessions, and backspace edits the picker search query.
- **TUI: resume picker rendering and navigation.** The picker now renders plain fixed-width rows without embedded ANSI escape codes, uses ASCII frame markers, accepts common arrow/enter/tab/escape key variants, and prevents picker keys from leaking into the prompt textarea.
- **TUI: unsupported `/mouse` removed from slash autocomplete.** The menu no longer advertises a command without a real dispatcher.

## [0.3.0-alpha.5]

### Fixed

- **Missing `extractTextContent` import in test files.**  \
  Three test suites (`context-hardening`, `deterministic-compaction`, `skills`) were missing the `extractTextContent` import from `../llm/types`, causing compilation failures. Added the import to all affected test files.

## [0.3.0-alpha.4]

### Added

- **Vision model support: `view_image` injects image content blocks.**  
  When `view_image` succeeds, the tool result is now exposed as a proper `image_url` content block in the conversation so vision-capable models (GPT-4V, Claude, etc.) can "see" the image. The image payload is stripped from token estimation to avoid 10–100× inflation vs real vision-tile costs.

- **LLM client: auto-detect `max_tokens` vs `max_completion_tokens`.**  
  The client now sends both `max_tokens` and `max_completion_tokens` by default and auto-detects which parameter is accepted on 400 errors, caching the correct choice per client instance. Fixes compatibility with newer OpenAI reasoning models (o1, o3, etc.) that reject `max_tokens`.

- **Token estimation: strip base64 image payloads.**  
  Context budget serialization now replaces large base64 image data with compact `[image:<bytes>]` placeholders before counting tokens, preventing catastrophic token inflation when images are present in conversation history.

### Changed

- **Tool definition path descriptions** updated to clarify that paths may be absolute or relative (not repo-relative only).
- **`AgentMessage.content`** type widened from `string` to `ChatContent` to support multimodal content arrays.

## [0.3.0-alpha.3]

### Fixed

- **Config: fix invalid/undefined `thinking` values in `resolveActive` and `configFromParsed`.**  
  Malformed or missing thinking settings in synax config files would cause crashes. Added safe fallbacks that default to off when the value is not a recognized string.

- **Prompt box: fix rendering issues and thinking block formatting.**  
  Multi-line prompt input now correctly handles the layout recalculation path without triggering full UI tree rebuilds, and thinking blocks render without visual glitches.

- **Fix `thinking` default in config.**  
  The `--thinking` CLI flag default is now properly wired through the config layer instead of being dropped.

## [0.3.0-alpha.2]

### Fixed

- **Reasoning sanitization: fix missing spaces when stripping `<think>` / `<thinking>` tags.**  
  Well-formed protocol XML tags (`<think>`, `<thinking>`, `<tool_call>`, `<invoke>`, `<function>`, `<parameter>`) were removed with an empty replacement string, which silently joined adjacent words when the tag was flush against surrounding text. Tags are now replaced with a space, preventing word-joining; duplicate whitespace is collapsed in a final cleanup pass. Affected three files: `stripToolCallMarkup` in the TUI display path, `sanitizeReasoning` in the tool-call repair path, and `assistantVisibleContent` in session formatting.

- **TUI prompt box: fix disappearing/overflow glitch on multi-line input.**  
  The prompt input height was included in `rootLayoutModeSignature`, causing a full UI tree rebuild every time the prompt wrapped to a new visual line. Removed `inputHeight` from the signature so height changes are handled in-place via the existing yoga layout recalculation path. Added `overflow: hidden` to the input frame box to prevent text overflow during the brief window before layout recalculation completes.

## [0.3.0-alpha.1]

Initial alpha release.
