# Agent Report: Bash Repetition Counter Reset on Meaningful Progress

## Problem

The previous patch attempted to raise `MAX_IDENTICAL_BASH_COMMANDS_PER_TURN` from 3 to 6 to allow edit+test mini-workflows where the same bash command (e.g., `make test`) is called repeatedly after each edit. This was rejected because it globally weakened the loop-protection invariant — the existing test expects 4 identical bash commands without progress to trigger the loop detector.

## Root Cause

The bash repetition counter in `ActionExecutor.detectRepeatedBash()` is a flat per-turn counter with no awareness of intervening file mutations. Each identical bash command increments the count unconditionally, and the threshold fires at 4 occurrences. Legitimate workflows like `edit → make test → edit → make test` exhaust the counter on the 4th `make test` call, even though meaningful progress (the edit) happened between them.

## Fix Applied

**File: `src/actions/ActionExecutor.ts`**

After executing the tool handler, if the call was a **successful** `edit` or `write`, the entire `bashCounts` map is cleared. This resets repetition tracking for all bash commands, treating the file mutation as a new "mini-workflow phase."

Key design choices:

1. **Only successful mutations reset.** A failed edit (e.g., `oldStr` mismatch) does *not* reset the counter. If the model tries to edit, fails, and keeps repeating the same bash command, the loop detector still fires — no safety weakening.

2. **Only `edit` and `write` reset.** Reads and other non-mutating tools do not count as progress. A read-loop followed by more identical bash commands will still be caught.

3. **The threshold itself is unchanged.** `MAX_IDENTICAL_BASH_COMMANDS_PER_TURN` remains 3. The global safety invariant is preserved.

4. **The reset is a `clear()`**, not selective. This is correct because the counter is per-command-key, and any file mutation signals the task is advancing. No need to track which specific bash commands were "related" to the edit.

## Tests Added

**File: `src/__tests__/runner.test.ts`**

### Test 1: `resets bash repetition counter after successful edit so edit-verify workflows survive`

Sequence: `bash → edit(success) → bash × 3 → content`

- 1 bash before edit (count starts at 1)
- Successful edit resets the counter
- 3 identical bash commands after edit (count goes 1→2→3, staying under threshold of 4)
- Model completes successfully

### Test 2: `does not reset bash counter on failed edits — loop detection still fires`

Sequence: `bash → edit(fail) → bash × 3 → (never reached)`

- 1 bash before edit (count = 1)
- Failed edit does NOT reset
- 3 more identical bash commands (count 2→3→4, reaches threshold)
- Loop detector fires on 4th bash, terminating with `tool_error`

### Existing test: `stops repeated identical bash commands before exhausting model steps`

Sequence: `bash × 4 → (never reached)` — **still passes unchanged.** No edit/write happens, so the counter is never reset. The 4th identical bash triggers the loop detector.

## Safety Invariant

The bash repetition detector enforces one rule: **≥4 identical bash commands without a successful file mutation in between is a stuck loop.** The reset-on-edit mechanism refines this to "without intervening progress" rather than weakening the threshold itself.

**Why this is safe:**

- Failed edits don't reset → repeated bash after repeated edit failures is still caught
- Non-mutation tools (read, search) don't reset → read-then-bash loops are still caught
- The per-command-key tracking still applies: 4 identical `git status` calls after an edit still fire (the edit just restarts the count from 0)
- The loop is still fatal (non-recoverable): the turn terminates with `tool_error`, not silently degraded

## Verification

```
npm test -- src/__tests__/runner.test.ts   # 65/65 pass
npm run typecheck                           # clean
npm run build                               # clean
```

## Changed Files

- `src/actions/ActionExecutor.ts` — reset bashCounts after successful edit/write
- `src/__tests__/runner.test.ts` — two new focused tests
