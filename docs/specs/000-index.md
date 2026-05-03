# Synax v0.1 Spec Index

Source requirements: `docs/synax-requirements-v1.2.md`

GitHub project: https://github.com/users/achuthanmukundan00/projects/5

This directory mirrors the GitHub issue breakdown for Synax v0.1. Each spec is intended to be executable by either a local coding agent or a cloud coding agent without requiring hidden context.

## Blunt Alignment Notes

The requirements document is directionally strong, but it is still too philosophical in places to execute directly. The main risk is building a generic agent shell and calling it "local-first" without proving the actual differentiator: visible context discipline plus strict edit/verification control.

Non-negotiable v0.1 boundaries:

- TypeScript CLI first.
- OpenAI-compatible Chat Completions first.
- Relay recommended, not required.
- One task at a time.
- One bounded verification command after an edit.
- `replace_in_file` before unified diff support.
- No ACP, MCP, IDE extension, multi-agent workflow, browser automation, cloud-first flow, plugin system, or autonomous PR workflow in v0.1.

## Issue Specs

| Spec | GitHub Issue | Title | Labels |
| --- | --- | --- | --- |
| `001-project-scaffold.md` | #1 | Bootstrap TypeScript CLI project scaffold | `type:feature`, `area:foundation`, `priority:p0` |
| `002-config-and-project-profile.md` | #2 | Implement `.synax.toml` config and project profile detection | `type:feature`, `area:config`, `area:foundation`, `priority:p0` |
| `003-provider-openai-compatible.md` | #3 | Implement OpenAI-compatible provider client and Relay-friendly configuration | `type:feature`, `area:provider`, `priority:p0` |
| `004-doctor-command.md` | #4 | Implement `synax doctor` diagnostics | `type:feature`, `area:cli`, `area:provider`, `priority:p0` |
| `005-tool-registry-and-inspection-tools.md` | #5 | Implement tool registry and deterministic read-only inspection tools | `type:feature`, `area:tools`, `area:inspection`, `priority:p0` |
| `006-context-ledger.md` | #6 | Implement context ledger with visible budgets and truncation markers | `type:feature`, `area:context-ledger`, `priority:p0` |
| `007-read-only-ask-flow.md` | #7 | Implement read-only `synax ask` codebase task flow | `type:feature`, `area:agent-loop`, `area:cli`, `priority:p1` |
| `008-patch-application-flow.md` | #8 | Implement strict `replace_in_file` patch proposal and application flow | `type:feature`, `area:patching`, `area:safety`, `priority:p0` |
| `009-verification-and-failure-states.md` | #9 | Implement bounded verification and explicit failure states | `type:feature`, `area:verification`, `area:safety`, `priority:p0` |
| `010-interactive-run-flow.md` | #10 | Implement interactive `synax` / `synax chat` / `synax run` loop | `type:feature`, `area:agent-loop`, `area:cli`, `priority:p1` |
| `011-v01-acceptance-demo.md` | #11 | Build v0.1 acceptance demo and regression fixtures | `type:test`, `area:acceptance`, `priority:p1` |

## Recommended Build Order

1. `001-project-scaffold.md`
2. `002-config-and-project-profile.md`
3. `003-provider-openai-compatible.md`
4. `004-doctor-command.md`
5. `005-tool-registry-and-inspection-tools.md`
6. `006-context-ledger.md`
7. `007-read-only-ask-flow.md`
8. `008-patch-application-flow.md`
9. `009-verification-and-failure-states.md`
10. `010-interactive-run-flow.md`
11. `011-v01-acceptance-demo.md`
