# Safety And Context

Synax treats context as a budget and file edits as explicit local operations.

## Context Budget

The main budget controls are:

| Setting                       | Default  | Use                                                  |
| ----------------------------- | -------- | ---------------------------------------------------- |
| `agent.context_budget_tokens` | `131072` | Overall context target for local high-context models |
| `agent.max_model_steps`       | `32`     | Maximum model turns per task                         |
| `agent.max_tool_calls`        | `96`     | Maximum tool calls per task                          |

Useful profiles:

| Budget   | Use                                                                                   |
| -------- | ------------------------------------------------------------------------------------- |
| `16000`  | Small or constrained local model                                                      |
| `65536`  | Normal local coding profile                                                           |
| `131072` | High-context local profile when the server was started with a matching context window |

## File Policy

Synax rejects unsafe file paths and generated outputs. It is designed to avoid reading or editing:

- `node_modules/`
- `.git/`
- build outputs
- coverage outputs
- env files
- paths outside the repository

Validated replacement edits emit a patch preview before Synax writes the file. In non-interactive
`synax run --task` sessions, previewed replacement edits are rejected by default; pass `--yes` to accept them for that
run. Direct runner callers can provide an approval callback.
Replacement writes are atomic (temp file + rename), so failed writes do not leave partial file content.
Replacement edits require a prior read of the same file in the current session and exact replacement text from that read.
The `run` command constrains tool access with `--mode`:

- `read-only`: read and git only.
- `patch`: read, write, edit, and git.
- `verify`: read and git only, with verification-focused output.
- `docs`: docs-oriented mutation only, still using read-before-edit.

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
Use `--verification-profile quick|full` and `--repair-attempts <n>` to control verification bounds.
`/verify quick` and `/verify full` run the configured verification command with bounded output limits for each profile.

## Dirty Working Trees

Synax exposes git status and diff through bounded read-only tools. It does not reset or clean the repository. Review changes with:

```sh
git status --short
git diff --stat
git diff
```

For run/task safety artifacts, Synax records:

- pre-run checkpoints under `.synax/checkpoints/`
- bounded run logs under `.synax/runs/`
- last Synax-owned edit metadata at `.synax/last-edit.json` for `/undo-last-edit`
