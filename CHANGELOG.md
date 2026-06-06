# Changelog

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
