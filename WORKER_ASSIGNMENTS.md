# Parallel Worker Assignments for Synax GitHub Issues

## Worker 1 (Pane 0): Provider & Context Window Issues (P0)
**Issues:** #145, #113
**Area:** `src/llm/`, `src/context-ledger/`
**Tasks:**
- Fix inaccurate model context window sizes in providers menu
- Remove hardcoded `maxTokens: 2048` that truncates model output
- Verify with `npm run typecheck && npm test`

## Worker 2 (Pane 1): Session ID Collision (P0)
**Issue:** #139
**Area:** `src/session/`, `src/events/`
**Tasks:**
- Fix session ID collision causing history.db corruption
- Ensure unique session IDs for concurrent processes
- Add tests for concurrent session handling

## Worker 3 (Pane 2): Agent Loop & Verification (P0/P1)
**Issues:** #112, #114
**Area:** `src/agent/`, `src/llm/`
**Tasks:**
- Fix verification contract being silently skipped
- Fix DeepSeek reasoningContent discarded when content field empty
- Ensure proper finalAnswer handling

## Worker 4 (Pane 3): TUI Input Issues (P1)
**Issues:** #152/#147, #151/#146
**Area:** `src/commands/`, TUI components
**Tasks:**
- Implement bracketed paste support in prompt input
- Fix prompt box overflow (text leaking below input area)
- Test with various input scenarios

## Worker 5 (Pane 4): TUI Enhancements (P2)
**Issues:** #155, #153/#148, #149/#144, #84
**Area:** `src/commands/`, TUI components
**Tasks:**
- Implement smooth scrolling with higher resolution
- Redesign settings menu (attractive, parseable, uses OpenTUI properly)
- Redesign splash screen (modern, personality-driven)
- Implement tab autocomplete for prompt box

## Worker 6 (Pane 5): Remaining Features & Polish
**Issues:** #143, #142, #141, #140, #154
**Area:** Various
**Tasks:**
- Render thinking blocks as markdown structure (not raw tokens)
- Add persistent status area (active model, context usage, working dir)
- Implement steering prompts queued-send workflow
- Add context-range paste tool
- Fix API costs rounding precision in TUI

---

## Verification Commands (run in each pane after changes):
```bash
npm run format
npm run typecheck
npm test
npm run build
```

## Communication:
- Each worker should update this file with progress
- Use `gh issue comment <num> --body "..."` to update issues
- Commit changes with descriptive messages referencing issue numbers