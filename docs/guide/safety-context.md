# Safety And Context

Synax treats context as a budget and file edits as explicit local operations.

## Context Budget

The main budget controls are:

| Setting | Default | Use |
| --- | --- | --- |
| `agent.context_budget_tokens` | `131072` | Overall context target for local high-context models |
| `agent.max_model_steps` | `32` | Maximum model turns per task |
| `agent.max_tool_calls` | `96` | Maximum tool calls per task |

Useful profiles:

| Budget | Use |
| --- | --- |
| `16000` | Small or constrained local model |
| `65536` | Normal local coding profile |
| `131072` | High-context local profile when the server was started with a matching context window |

## File Policy

Synax rejects unsafe file paths and generated outputs. It is designed to avoid reading or editing:

- `node_modules/`
- `.git/`
- build outputs
- coverage outputs
- env files
- paths outside the repository

## Bash Policy

Bash is disabled by default:

```toml
[tools.bash]
enabled = false
```

The model does not see the bash tool unless it is enabled. Prefer configured verification commands over unrestricted shell access.

## Verification

Configure one verification command:

```toml
[verification]
defaultCommand = "npm run typecheck"
```

Run it inside chat:

```txt
/verify
```

`synax run --task` also reports verification state when a command is configured.

## Dirty Working Trees

Synax exposes git status and diff through bounded read-only tools. It does not reset or clean the repository. Review changes with:

```sh
git status --short
git diff --stat
git diff
```
