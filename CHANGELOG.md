# Changelog

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
