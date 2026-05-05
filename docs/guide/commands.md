# Commands

## `synax`

With no arguments, Synax starts `chat`.

```sh
npm run synax --
```

## `synax chat`

Interactive agent shell:

```sh
npm run synax -- chat
```

Single-turn chat:

```sh
npm run synax -- chat --message "Explain the test layout."
```

Slash commands:

| Command | Behavior |
| --- | --- |
| `/help` | Show available chat commands |
| `/settings` | Show provider, agent, tool, and verification settings |
| `/settings set <path> <value>` | Change a supported setting for the current session |
| `/tools` | Show model-facing tool surface |
| `/budget` | Show context and loop limits |
| `/test-provider` | Probe provider models and chat endpoints |
| `/inspect` | Show project profile |
| `/verify` | Run configured verification command |
| `/clear` | Reset the chat conversation and inspection ledger |
| `/status` | Show git and budget status |
| `/exit`, `/quit` | Exit chat |

## `synax ask`

Runs one bounded question or task and exits:

```sh
npm run synax -- ask --question "Where is provider config normalized?"
```

Output modes:

```sh
npm run synax -- ask --question "Summarize the CLI" --quiet
npm run synax -- ask --question "Summarize the CLI" --json
npm run synax -- ask --question "Summarize the CLI" --json --debug
```

`--quiet` and `--json` cannot be combined. `--quiet` and `--debug` cannot be combined.

## `synax run`

Runs one bounded edit-capable agent task:

```sh
npm run synax -- run --task "Fix the failing auth test"
```

`--yes` is accepted for compatibility. Safe edit tools print a patch preview before applying a validated
replacement, but interactive accept/reject prompting is not implemented yet.

Plan files are not implemented yet:

```sh
npm run synax -- run --plan plan.md
```

## `synax inspect`

Inspects project metadata:

```sh
npm run synax -- inspect
npm run synax -- inspect --json
npm run synax -- inspect --profile
npm run synax -- inspect --brief
npm run synax -- inspect --section git --section packageManager
```

## `synax config`

```sh
npm run synax -- config init
npm run synax -- config show
npm run synax -- config get provider.model
```

## `synax doctor`

Quick local checks:

```sh
npm run synax -- doctor
```

Full provider checks:

```sh
npm run synax -- doctor --full
```
