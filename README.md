# Synax

Synax is a TypeScript-first local coding agent for developers running local LLMs through Relay or another OpenAI-compatible gateway.

It is CLI-first, local-first, and built for constrained local models. Synax keeps model-visible context, tool calls, command output, and file edits bounded and inspectable.

## What Synax Is

- A local CLI coding agent.
- A Relay-compatible OpenAI-style chat client.
- A bounded file inspection, edit, and verification loop.
- A small TypeScript project intended to stay understandable.

## What Synax Is Not

Synax is not a cloud agent platform, SaaS product, IDE, web dashboard, daemon, database-backed memory system, or parallel-agent framework.

## Requirements

- Node.js 18 or newer.
- npm.
- Git.
- Relay or another OpenAI-compatible `/v1/chat/completions` server.

## Install

```sh
git clone git@github.com:achuthanmukundan00/synax.git
cd synax
npm install
npm run build
```

Run the local built CLI through npm:

```sh
npm run synax -- --help
```

After package linking or publishing, the command name is:

```sh
synax
```

## Relay Quick Start

Start Relay with a model exposed through an OpenAI-compatible endpoint. Synax defaults to:

```txt
http://127.0.0.1:1234/v1
```

Create a project config:

```sh
cp .synax.toml.example .synax.toml
```

Set the provider model to the exact model ID Relay lists from `/models`:

```toml
[provider]
preset = "relay-local"
kind = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
api_key = "sk-no-key-required"
timeout_seconds = 120
```

Check local setup:

```sh
npm run synax -- doctor
```

Check Relay and the configured model:

```sh
npm run synax -- doctor --full
```

Compatibility claims should be recorded against an exact provider, model, and Synax version. Use `docs/guide/compatibility.md` for the current compatibility report format and matrix.

## Common Commands

```sh
# Inspect repository and config context
npm run synax -- inspect

# Show context budget configuration
npm run synax -- inspect --budget

# Show current working context state (after a chat session)
npm run synax -- inspect --ledger

# List or read bounded local docs/spec context
npm run synax -- inspect --docs
npm run synax -- inspect --doc specs/PRD.md

# Ask one bounded question
npm run synax -- ask --question "Where is provider config normalized?"

# Start an interactive coding session
npm run synax -- chat

# Run one bounded edit-capable task; --yes accepts previewed replacement edits
npm run synax -- run --task "Fix the failing test" --yes

# Constrain the task surface
npm run synax -- run --mode read-only --task "Inspect the command registry and identify one safe improvement. Do not modify files."
npm run synax -- run --mode patch --task "Make one minimal docs-only wording improvement in README.md, then run npm run typecheck."

# Show config
npm run synax -- config show
```

Inside `synax chat`:

```txt
/help
/settings
/tools
/budget
/test-provider
/inspect
/verify
/verify quick
/verify full
/diff
/undo-last-edit
/clear
/status
/exit
```

Session-only settings changes are available:

```txt
/settings set provider.endpoint http://127.0.0.1:1234/v1
/settings set provider.model Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf
/settings set agent.context_budget_tokens 65536
/settings set agent.max_model_steps 24
/settings set agent.max_tool_calls 64
```

For large pasted prompts, use bracketed paste in the terminal. Synax detects the paste boundary,
shows a compact inline chip such as `[pasted: 84 lines, 12.4k chars]`, and submits the full pasted body
only when you press Enter.

Typed slash commands still execute normally. A pasted slash command is treated as literal content.

## Configuration

Synax loads configuration from built-in defaults, optional global config at `~/.config/synax/config.toml`, and the nearest project `.synax.toml`.

Useful project config:

```toml
[agent]
context_budget_tokens = 131072
max_model_steps = 32
max_tool_calls = 96

[subagents]
enabled = false
mode = "sequential"

[verification]
defaultCommand = "npm run typecheck"

[provider]
preset = "relay-local"
kind = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
api_key = "sk-no-key-required"
timeout_seconds = 120

[tools]
exposed = ["read", "write", "edit", "git"]
shell = "zsh"
unsafe = false

[tools.bash]
enabled = false
```

Environment overrides:

```sh
SYNAX_CONTEXT_BUDGET_TOKENS=65536
SYNAX_MAX_MODEL_STEPS=24
SYNAX_MAX_TOOL_CALLS=64
```

## Agent Loop

Synax manages context as a runtime discipline, not just a model instruction:

- **Budget model**: Approximate token estimation (chars/3.5). Compaction triggers at ~60% of effective limit.
- **Working context orientation**: After each read, the model receives a compact block listing inspected files, editable-from-memory files, truncated files needing reread, and git inspection state.
- **Progressive loop resistance**: Duplicate reads escalate: cached return → warning with guidance → hard failure with orientation summary.
- **Tool result compaction**: Large reads are truncated at per-read and per-turn caps. Repeated results are cached. Omitted reads return zero-token guidance instead of partial content.
- **Edit safety**: Exact-text edits require a prior complete (non-truncated) read of that file region.
- **Deterministic compaction**: When context exceeds budget, older messages are compacted into structured summaries without LLM calls.

View context state:

```sh
synax inspect --budget    # budget configuration
synax inspect --ledger    # working context state from last session
```

Synax sends a compact OpenAI-compatible tool surface to the model:

| Tool    | Purpose                                         |
| ------- | ----------------------------------------------- |
| `read`  | List files, read bounded ranges, or search text |
| `edit`  | Exact `replace_in_file` edits                   |
| `write` | Create new repo-local text files                |
| `git`   | Show bounded git status or diff                 |
| `bash`  | Hidden unless explicitly enabled                |

The model loop stops when the model returns a final answer, hits the configured model-step limit, hits the configured tool-call limit, or encounters a tool/provider error.

`synax run --plan plan.md` is currently a placeholder. Native Anthropic protocol support, browser UI, IDE integration, databases, Docker infrastructure, and parallel agents are out of scope.

## Docs Site

The formatted documentation lives in `docs/` and is built with VitePress:

```sh
npm run docs:dev
npm run docs:build
npm run docs:preview
```

GitHub Pages deployment is configured in `.github/workflows/pages.yml`. In the GitHub repository settings, set Pages source to GitHub Actions.

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## Smoke Tests

Use these bounded self-development smoke tests when changing Synax itself:

```sh
npm run synax -- run --mode read-only --task "Inspect README.md and summarize Synax in 5 bullets. Do not modify files."
npm run synax -- run --mode patch --task "Make one minimal docs-only wording improvement in README.md, then run npm run typecheck."
npm run synax -- inspect
npm run synax -- doctor --full
```

## License

MIT
