# Commands

## `synax`

With no arguments, Synax starts `chat` in full-screen TUI mode when attached to a TTY.

```sh
bun run synax --
```

## `synax chat`

Interactive agent shell (full-screen TUI by default on TTY):

```sh
bun run synax -- chat
```

The full-screen TUI uses OpenTUI and runs under Bun. Use `--plain` when you need the non-TUI fallback.
Use `--cmux-mode` when running many parallel TUI sessions and you want lower frame churn.

Plain fallback:

```sh
bun run synax -- chat --plain
```

Single-turn chat:

```sh
bun run synax -- chat --message "Explain the test layout."
```

Slash commands:

| Command                        | Behavior                                              |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------- |
| `/help`                        | Show available chat commands                          |
| `/settings`                    | Show provider, agent, tool, and verification settings |
| `/settings set <path> <value>` | Change a supported setting for the current session    |
| `/tools`                       | Show model-facing tool surface                        |
| `/budget`                      | Show context and loop limits                          |
| `/test-provider`               | Probe provider models and chat endpoints              |
| `/inspect`                     | Show project profile                                  |
| `/verify [quick                | full]`                                                | Run configured verification command |
| `/diff`                        | Show bounded git status and diff                      |
| `/status`                      | Show git, budget, checkpoint, and read-state summary  |
| `/clear`                       | Reset the chat conversation and inspection ledger     |
| `/exit`, `/quit`               | Exit chat                                             |

For large pasted prompts, use terminal bracketed paste. Synax detects paste boundaries and renders the
paste as an inline attachment chip:

```txt
synax> take a look at this [pasted: 84 lines, 12.4k chars] and modify the twelfth line
```

The full pasted body is held locally until Enter is pressed, then Synax submits a single canonical
message that preserves the typed text before and after the paste. Typed slash commands still execute as
commands, but a slash command inside a paste is treated as literal content.

## `synax ask`

Runs one bounded question or task and exits:

```sh
bun run synax -- ask --question "Where is provider config normalized?"
```

Output modes:

```sh
bun run synax -- ask --question "Summarize the CLI" --quiet
bun run synax -- ask --question "Summarize the CLI" --json
bun run synax -- ask --question "Summarize the CLI" --json --debug
```

`--quiet` and `--json` cannot be combined. `--quiet` and `--debug` cannot be combined.

## `synax run`

Runs one bounded edit-capable agent task:

```sh
bun run synax -- run --task "Fix the failing auth test"
```

Task modes constrain the tool surface:

```sh
bun run synax -- run --mode read-only --task "Inspect the registry and summarize safe improvements"
bun run synax -- run --mode patch --task "Make one docs-only wording improvement in README.md"
bun run synax -- run --mode verify --task "Inspect the patch and report whether verification is safe"
bun run synax -- run --mode docs --task "Update docs/guide/commands.md with one small wording fix"
```

Replacement edits print a patch preview before writing. Because `run` is non-interactive, previewed replacement
edits are rejected by default. Pass `--yes` to accept previewed replacement edits during that run:

```sh
bun run synax -- run --task "Fix the failing auth test" --yes
bun run synax -- run --task "Fix the failing auth test" --yes --verification-profile full --repair-attempts 1
```

Plan files are not implemented yet:

```sh
bun run synax -- run --plan plan.md
```

Verification profiles:

```sh
bun run synax -- run --task "Fix the failing auth test" --verification-profile quick
bun run synax -- run --task "Fix the failing auth test" --verification-profile full
```

Run control-surface TUI (stable frame, no log spam):

```sh
bun run synax -- run --task "Fix the failing auth test" --tui
bun run synax -- run --task "Fix the failing auth test" --tui --cmux-mode
```

The TUI is an opt-in MVP that shows a fixed-frame control surface during `synax run`:

- Phase machine (idle → thinking → tool_execution → verifying → completed/blocked/error)
- Severity ladder (S0–S3) and risk line
- Compact timeline of recent events
- Change file list with overflow compression
- Verification lifecycle counts (planned, running, passed, failed, skipped)
- 9×9 AI core overlay indicating internal state
- SIGWINCH resize repaint

Current run-TUI limitations:

- `synax run --tui` remains the non-interactive run surface
- Fixed layout; no scrolling panes or log streaming
- No interactive controls beyond `q` to quit
- Verification status is derived from lifecycle events emitted by the runtime (not summary text parsing)
- Small terminals (< 40 cols, < 18 rows) show a minimal warning

## `synax inspect`

Inspects project metadata:

```sh
bun run synax -- inspect
bun run synax -- inspect --json
bun run synax -- inspect --profile
bun run synax -- inspect --brief
bun run synax -- inspect --section git --section packageManager
bun run synax -- inspect --docs
bun run synax -- inspect --doc specs/PRD.md
bun run synax -- inspect --search-docs "relay"
bun run synax -- inspect --docs-impact
```

`--docs` lists the bounded local docs/spec files Synax recognizes. `--doc <path>` reads one recognized
docs/spec file with line numbers and the same secret redaction used by the local docs provider.
`--search-docs <query>` performs deterministic bounded text search across recognized docs.
`--docs-impact` reports when behavior-facing source changes likely need docs updates.

## `synax config`

```sh
bun run synax -- config init
bun run synax -- config show
bun run synax -- config get provider.model
```

## `synax doctor`

Quick local checks:

```sh
bun run synax -- doctor
```

Full provider checks:

```sh
bun run synax -- doctor --full
```

## Typical Workflow

<MeasuredTerminalBlock
  title="synax session"
  :lines="[
    'synax chat',
    '/status',
    '  core: qwen-coder',
    '  provider: relay (local)',
    '  ctx: 0 / 32768',
    '',
    '> fix the type error in src/config.ts',
    '',
    '  reasoning: type mismatch...',
    '  read src/config.ts',
    '  edit src/config.ts',
    '  test bun run test',
    '  result: verification passed',
    '',
    '/status',
    '  state: succeeded',
  ]"
  :dimLines="[4, 5, 6, 7]"
  ariaLabel="Example Synax session showing status, a coding request, tool calls, and completion"
/>
