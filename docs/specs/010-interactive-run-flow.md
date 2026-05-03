# Implement interactive `synax` / `synax chat` / `synax run` loop

GitHub labels: `type:feature`, `area:agent-loop`, `area:cli`, `priority:p1`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/10

Local spec mirror: `docs/specs/010-interactive-run-flow.md`

## Problem

The product journey is a disciplined CLI loop. The implementation must expose that without becoming a vague autonomous shell.

## Scope

Implement the interactive and edit-capable user flows.

## Requirements

- `synax` starts interactive mode.
- `synax chat` aliases interactive mode.
- `synax run "..."` runs an edit-capable bounded task.
- Each task follows: inspect, ledger, model response, optional patch validation, diff, confirmation, apply, one verification, final report.
- Warn and require confirmation before edit-capable flows on dirty working trees.
- Ask the user to narrow broad tasks or convert them into read-only inspection.
- Maintain human agency for risky, destructive, broad, or ambiguous actions.

## Acceptance Criteria

- Interactive mode accepts one task at a time.
- `run` mode can complete a small patch task using the patch and verification specs.
- Final reports include context used, files changed, verification command, verification result, and completion state.
- The loop does not recursively plan or autonomously wander.

## Out Of Scope

- TUI.
- Multi-agent orchestration.
- Autonomous multi-hour sessions.
- Automatic PR generation.
