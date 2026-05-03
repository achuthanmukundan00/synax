# Implement bounded verification and explicit failure states

GitHub labels: `type:feature`, `area:verification`, `area:safety`, `priority:p0`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/9

Local spec mirror: `docs/specs/009-verification-and-failure-states.md`

## Problem

Synax must not pretend work is complete. Verification must be explicit, bounded, and reported honestly.

## Scope

Implement one-step verification and predictable failure handling.

## Requirements

- Run at most one bounded verification command by default after applying a patch.
- Select verification command from detected scripts, config, user input, or model recommendation approved by user.
- Show command, exit code, truncated output if needed, and pass/fail/skipped state.
- Implement failure states for malformed model output, invalid patches, unread-file patch attempts, replacement match failures, verification failures, provider failures, context budget exceeded, ambiguous tasks, and dirty working tree.
- Allow one optional diagnosis pass after verification failure. Do not enter an automatic fix-test loop.

## Acceptance Criteria

- Verification result is included in final task report.
- Failed verification marks task failed or partially complete.
- Skipped verification is reported as unverified.
- Malformed tool calls or patches get one repair attempt, then stop.
- Context truncation and dirty working tree warnings are visible.

## Out Of Scope

- Automatic repeated repair loops.
- Long-running background command orchestration.
- Network/install/destructive commands without explicit approval.
