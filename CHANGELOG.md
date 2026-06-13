# Changelog

## [0.3.0-beta]

### Breaking

- **Read results are now budgeted and truncated.** Previously "dogfooding mode" passed through all read output untruncated. Read results are now subject to a per-read token cap (with continuation guidance via `startLine`) and a per-turn cumulative cap, after which further reads are refused with a recoverable policy error. This keeps context from being swamped by large reads.
- **`maxToolCalls` and `maxModelSteps` are now enforced.** Previously both were set to `Number.MAX_SAFE_INTEGER` (effectively unlimited). Defaults are now `maxToolCalls=192`, `maxModelSteps=64`. Runaway loops now hit a hard stop with `budget_exhausted`.
- **Bash is now enabled by default.** Previously disabled-by-default. The docs and `[tools.bash]` behavior are updated accordingly. Disable via `[tools.bash] enabled = false`.
- **Per-turn read budget cap removed.** The cumulative per-turn token cap on read results (`maxTotalReadResultTokensPerTurn`) is now 0 (unlimited). The context window itself, compaction, and subagent handoff serve as the natural budget. Hard-capping reads mid-investigation was amputating the model: once exhausted, every read returned an error and the model could not gather any new information.
- **Identical-read loop detection is now a hard stop.** Previously the read handler injected soft nudges on repeated identical reads. Now `Session` tracks identical-read counts (keyed by path + line range) and terminates the turn with `tool_error` after 5 consecutive identical reads. Dogfooding mode (`SYNAX_DOGFOOD`) disables the limit. Different line ranges on the same file are NOT treated as identical.

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
- **TUI: splash screen redesign.** The splash screen now features a styled SYNAX wordmark with model-palette accent colors, a decorative box frame, tagline, and version line. Layout adapts to narrow/medium/wide terminals and cycles the wordmark accent color with each animation frame. Metadata is presented in a two-column grid with provider and uptime.
- **TUI: markdown rendering in thinking blocks.** Thinking cards now render structural markdown: ATX headings, bold headings, unordered/ordered lists, code fences, and inline formatting (bold, italic, code, links). Uses muted thinking-block styling to maintain a distinct visual identity from assistant messages.
- **`paste_context_range` tool.** New tool for context materialization: slices a range from the last user message using line numbers, anchor text, or byte offsets and writes it to a temp file (with sha256 verification). Supports multibyte unicode correctly and records the operation in the ledger.
- **Model context window auto-probe for relay/custom providers.** New `probeModelContextWindow()` queries `/v1/models` and `/v1/model` endpoints to discover the actual context window from server metadata (`max_context_length`, `max_model_len`, etc.). Runs at startup for non-cloud providers and overrides the configured context window. 3-second timeout, best-effort.
- **Gemma 3/4 native tool call support.** Gemma 3 and 4 models now use the `gemma_native` parser, which forces OpenAI-native `role: 'tool'` / `tool_call_id` conventions instead of XML-wrapped `<tool_response>` user messages. Gemma's chat template understands this format natively.
- **Runtime environment context injected into skill messages.** The model now receives repo path, home directory, username, and platform at the top of the skill message block. This grounds tool-call paths in the real environment instead of hallucinating `/home/user` or random absolute paths.
- **Bash enabled for all run modes.** Bash is now available in every mode (not just `patch`/`verify`). Read-only questions routinely need `git status`, `git diff`, and `git log` — without bash the model had no way to answer them and looped on directory listings.
- **Invalid-arguments errors are now recoverable.** When the model sends wrong argument names, the error is treated as recoverable so the model can self-correct on the next step instead of terminating the turn.
- **Image paste/drag support in TUI.** Pasting or dragging image files (png, jpg, gif, webp, bmp) into the prompt detects them, shows a compact `[📷 path]` indicator, and encodes them as multimodal content blocks at submit time. Vision models receive them as proper `image_url` content alongside the text prompt.
- **Session resume rebuilds transcript from persisted event log.** When resuming a session, the TUI now rebuilds visible transcript cards from the full persisted event log (`readSessionEvents` → `semanticEventsFromSessionEvents`) instead of showing a blank feed. The model's conversation context is restored behind the system prefix as before; the transcript shows the prior conversation above the prompt.
- **Multiple named themes.** Added 8 new TUI palettes alongside the default mono theme: gruvbox, kanagawa, catppuccin, nord, rose-pine, tokyo-night, pink, and dracula. Each has its own semantic color mapping, background, surface, border, and text colors.
- **`wordWrapLines` utility.** New text utility for word-boundary-aware line wrapping that matches OpenTUI's `wrapMode: 'word'` behavior. Falls back to character-level breaks for unbreakable words exceeding the width.
- **`applyFeedOperations` helper.** Extracted from inline TUI code: applies an `IncrementalFeedModel` render plan (append/update/remove operations) to a ScrollBox container with correct card index offset accounting.
- **Jest HOME isolation for tests.** A new setup file (`src/__tests__/helpers/jest-home.ts`) redirects `HOME` to a per-run temp directory so test suites don't flood the developer's real session index with fake sessions.

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
- **TUI: expand/collapse removed.** Tool result cards and thinking cards no longer truncate or toggle. All content is always fully visible. Thinking cards collapse to a one-line preview on finalization (retitled from "Stopped thinking" to "Thought"). Removed `ExpandedState`, `Enter`-on-empty toggle, `Ctrl+E` toggle-all, `Ctrl+O` toggle, and `e` key toggle. The ScrollBox naturally handles long content — manual expand/collapse was unnecessary overhead.
- **TUI: renderer background set to transparent.** The renderer creation-time background is now `'transparent'` instead of a hardcoded dark color, so the terminal's native background shows through regardless of theme.
- **TUI: splash screen redesigned with token-stream frames.** The splash card now uses the model's token-stream character set (staggered rows) instead of the deleted `ai-core` visualizer. Layout is responsive and narrow-friendly with a colored accent bar, model name (middle-ellipsized for long GGUF filenames), and a single metadata row whose segments drop right-to-left when the terminal is narrow.
- **Removed `src/tui/ai-core.ts` and `src/tui/core-visual-profile.ts`.** These splash visualizer modules have been replaced by the token-stream-based splash card in `opentui-artifact-renderer.ts`.
- **TUI: settings and resume overlay lines update in place.** Navigation within overlays no longer triggers a full tree rebuild — only the text content of each line node is updated. Backdrop rows now include solid-fill `Text` children so the transcript behind the overlay doesn't bleed through below the modal frame. Prompt input is blurred while overlays are open.
- **TUI: prompt cursor changed to block (non-blinking).** The input cursor style changed from `line`/blinking to `block`/non-blinking for better visibility.
- **TUI: slash info panel pre-wrapped.** Slash-command info lines are pre-wrapped to the terminal width before layout, so the physical row count exactly matches what `footerLayoutHeight` computes — preventing overlap with the input.
- **TUI: ScrollBox vertical scrollbar hidden.** With `stickyScroll` locked to the bottom, the scrollbar was just visual noise that painted block-char columns over the right edge of result cards.
- **TUI: prompt cards render at full text brightness.** The user's own prompt words now use `pal.text` instead of `pal.textMuted`, making them the easiest thing to spot when scanning a long transcript.
- **TUI: root layout always uses full mode.** The compact-startup vs. full layout distinction is removed — the root structure stays the same between splash and transcript, so transitions are handled incrementally by the feed model without a full tree destroy+rebuild.
- **TUI: resize updates dimensions in place.** Terminal resize now updates root node dimensions and recalculates layout without destroying the tree, avoiding the blank-frame flicker of a full rebuild.
- **TUI: context budget bar restyled.** The bar now uses smooth cap-free half-blocks (`▰` filled / `▱` empty) instead of `▐`...`▌` delimiters.
- **TUI: cost suffix simplified.** Footer cost now shows only cumulative session spend; per-token in/out pricing is removed to reduce footer clutter.
- **TUI: resume picker frame matches settings modal.** The resume picker now uses the same box-drawing characters (`┌─┐` / `│` / `└─┘`) as the settings overlay. Selected rows use `→` instead of `>`. Footer hint simplified.
- **TUI: thinking cards finalized and collapsed in place.** On `tool_started`, `assistant_message`, `model_step_started`, or `task_finished`, the live thinking card is finalized in place (collapsed to first line, retitled "Thought") and a new thinking card starts for the next burst. This keeps thinking blocks in true stream order without moving them.
- **TUI: session filtering skips zero-event sessions.** Sessions with no recorded events are excluded from the resume picker to avoid dead-end restores.
- **TUI: home path normalization in prompt input.** Absolute paths under `$HOME` are normalized to `~/` prefix so the model's tools accept them. Also applies to pasted/dragged text.
- **TUI: streaming delta dedup for cumulative providers.** Some servers re-send the full accumulated text in each SSE delta. The presentation reducer now tracks `lastDeltaContent`/`lastDeltaReasoning` and strips the previously-seen prefix, preventing doubled paragraphs. The thinking card path handles this independently for reasoning streams.

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
- **Session ID collision defenses.** `EventStore` uses `startsWith('SQLITE_CONSTRAINT')` to catch `SQLITE_CONSTRAINT_UNIQUE` from better-sqlite3; `createSession` detects existing sessions before creation and throws a collision error; `SessionFactory` re-throws collision errors from `createStoreSession` instead of silently swallowing them; `generatePersistentSessionId` adds millisecond precision to match store-level granularity.
- **Robust bracketed paste handling.** Position-aware bracket detection prevents false matches inside pasted text; keypress events (keybindings, autocomplete, submit) are suppressed during raw bracketed paste to avoid double-insertion and interference; multi-byte UTF-8 and emoji are captured via `key.sequence` for printable characters.
- **Reasoning content forwarded through report pipeline.** `reasoningContent` is now forwarded through `RunTaskReport` → `ChatTurnReport` so downstream consumers (session store, TUI, run log) can access it independently of `finalAnswer`.
- **Prompt box overflow with word-wrap height simulation.** Replaced character-level wrap calculation with word-wrap simulation matching OpenTUI's `wrapMode: 'word'` behavior; long unbreakable words are force-broken; footer gets `overflow: hidden` to clip bleed into adjacent regions.
- **Verification contract resolved from mode.** `startTurn()` now resolves the verification contract from the mode when not explicitly set (`patch` → `files_changed`, `verify` → `verification_passed`, others → `none`) instead of silently skipping the check when the contract is `null`.
- **Centralized cost formatting with adaptive precision.** `formatCost` and `formatPricePer1M` moved to `src/tui/telemetry.ts` as shared exports; `formatCost` uses 2dp for ≥$100, 4dp for ≥$0.0001, and up to 10dp for sub-cent values; `formatPricePer1M` strips trailing zeros; eliminates duplicated local implementations and the `$0.00` display for small but real API calls.
- **Corrected model context window sizes.** DeepSeek V4 Pro/Flash preset changed from 1M to 128K (the 1M figure was a copy-paste error); added per-model window overrides with `resolveContextWindow()` as the single source of truth; canonical values added for `deepseek-chat` (128K) and `deepseek-reasoner` (64K).
- **TUI: overlay desync guards.** The render loop now detects when an overlay should exist but its nodes are missing (or vice versa) and forces a tree rebuild. Previously resizing with an overlay open could leave orphaned overlay nodes permanently blanking the view.
- **TUI: prompt input blurred under overlay.** When settings or the resume picker is open, the prompt input is blurred and its cursor hidden so the terminal cursor doesn't blink behind the modal. Refocused when the overlay closes.
- **TUI: root height synced on terminal resize.** The root node's height is now kept in sync with `renderer.height` on every render cycle, fixing Yoga layout drift when the terminal is resized while an overlay is open.
- **TUI: card index offset for session header.** The session header card occupies the first ScrollBox slot, so event index N maps to child index N+1. Without this offset, updated cards (notably the streaming thinking card) were re-inserted one slot too early and drifted above the previous prompt or tool call.
- **TUI: autocomplete draft cleared after bracketed paste.** After a bracketed paste completes, the autocomplete draft is cleared so a pasted path starting with `/` doesn't lock the prompt into slash-autocomplete mode.
- **TUI: preinserted prompt card suppression.** When the TUI pre-inserts a prompt card for immediate feedback, the event sink's subsequent `user_message` event is suppressed to avoid a duplicate prompt card in the transcript.
- **TUI: thinking card delta handles cumulative reasoning servers.** Some servers send the full accumulated reasoning text in each SSE delta. The thinking card path now computes a true delta by comparing the previously-sanitized body to the current one, and strips the prefix of a previously-finalized block when a new thinking burst starts.
- **TUI: `isModelHistoryBoundary` corrected.** The duplicate-model-history detection now treats any non-`model` item as a boundary (not just `user` items), preventing dedup collisions across tool results and other non-model history entries.

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
