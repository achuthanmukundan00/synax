# Implement read-only `synax ask` codebase task flow

GitHub labels: `type:feature`, `area:agent-loop`, `area:cli`, `priority:p1`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/7

Local spec mirror: `docs/specs/007-read-only-ask-flow.md`

## Problem

Read-only codebase explanation is the safest proof that Synax can inspect deliberately, build context visibly, and answer with grounded citations.

## Scope

Implement `synax ask "..."` for explanation, tracing, and diagnosis without edits.

## Requirements

- Run a bounded task loop for read-only prompts.
- Allow model-requested inspection through the controlled tool registry.
- Build and show the context ledger.
- Answer with cited file paths and line ranges when code is discussed.
- Refuse or downgrade edit requests in `ask` mode.
- Stop safely on malformed tool calls after one repair attempt.

## Acceptance Criteria

- `synax ask "trace X"` performs repo inspection before answering.
- No files are modified in ask mode.
- Answers include inspected file references and line ranges when applicable.
- The context ledger is shown.
- Broad prompts are narrowed or converted to top concrete inspection targets.

## Out Of Scope

- Applying patches.
- Verification commands.
- Long autonomous planning sessions.
