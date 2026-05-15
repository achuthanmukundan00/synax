# Synax

[![CI](https://github.com/achuthanmukundan00/synax/actions/workflows/ci.yml/badge.svg)](https://github.com/achuthanmukundan00/synax/actions/workflows/ci.yml)

Synax is a TypeScript-first local coding agent for developers running local LLMs through Relay or another OpenAI-compatible gateway.

It is CLI-first, local-first, and built for constrained local models. Synax keeps model-visible context, tool calls, command output, and file edits bounded and inspectable.

## What Synax Is

- A local-first CLI coding agent with multi-provider routing.
- A modular pipeline: **Session** orchestrator → **EventBus** pub/sub → **ActionExecutor** tools.
- Native tool-call parsers for 26 model families — no vLLM normalization needed.
- **Holographic Memory**: SQLite FTS5 semantic memory with zero token overhead.
- **Recovery Recipes**: pre-programmed failure survival for empty responses, bash failures, context exhaustion, and infinite loops.
- **Skills**: drop `SKILL.md` files into `.synax/skills/` to inject domain behavior.
- **Extensions**: typed EventBus, custom tools, custom parsers, custom repairers.
- A small TypeScript project intended to stay understandable.

## What Synax Is Not

Synax is not a cloud agent platform, SaaS product, IDE, web dashboard, daemon, database-backed memory system, or parallel-agent framework.

## Features

| Feature | Description |
|---------|-------------|
| Adaptive Context | Token estimation, deterministic compaction at ~60% budget, progressive loop resistance |
| Holographic Memory | SQLite FTS5 — zero tokens burned, agent queries what it needs |
| Recovery Recipes | Empty response, bash failure, context exhaustion, infinite loop survival |
| Handoff Manager | Context exhaustion → clean child session with FTS5 inheritance (depth-capped at 3) |
| Skills | Auto-discovered `SKILL.md` files from global and project directories |
| Typed EventBus | Lifecycle events + `pre_tool_use` control hooks with allow/block decisions |
| Native Parsers | 26 model families — Qwen XML, Hermes, Llama 3, Mistral, Pythonic, JSON-in-tags |
| Edit Safety | Exact-text edits require prior complete read; verification profiles |
| MCP Bridge | Guarded Model Context Protocol export/import scaffold |

See the [Architecture Guide](/docs/guide/architecture) for module diagrams and data flow.

## Requirements

- Bun 1.2 or newer.
- Bun.
- Git.
- Relay or another OpenAI-compatible `/v1/chat/completions` server.

## Install

```sh
git clone git@github.com:achuthanmukundan00/synax.git
cd synax
bun install
bun run build
```

Run the local built CLI through Bun:

```sh
bun run synax -- --help
```

After package linking or publishing, the command name is:

```sh
synax
```

## Provider Quick Start

Synax works with local Relay, cloud APIs, and any OpenAI-compatible endpoint. Pick your provider:

### Local Relay (default)

```sh
cp .synax.toml.example .synax.toml
```

```toml
[provider]
provider = "relay"
base_url = "http://127.0.0.1:1234/v1"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
context_window = 131072
```

### Cloud Providers

```toml
[provider]
provider = "deepseek"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"
```

```toml
[provider]
provider = "anthropic"
model = "claude-sonnet-4-5-20250929"
api_key_env = "ANTHROPIC_API_KEY"
```

Built-in presets: `relay`, `deepseek`, `anthropic`, `openrouter`, `groq`, `mistral`, `together`, and `custom` for any OpenAI-compatible endpoint. See `docs/guide/providers.md` for full configuration.

Check setup:

```sh
bun run synax -- doctor
bun run synax -- doctor --full
```

Compatibility claims should be recorded against an exact provider, model, and Synax version. Use `docs/guide/compatibility.md` for the current compatibility report format and matrix.

## Common Commands

```sh
# Inspect repository and config context
bun run synax -- inspect

# Show context budget configuration
bun run synax -- inspect --budget

# Show current working context state (after a chat session)
bun run synax -- inspect --ledger

# List or read bounded local docs/spec context
bun run synax -- inspect --docs
bun run synax -- inspect --doc specs/PRD.md

# Ask one bounded question
bun run synax -- ask --question "Where is provider config normalized?"

# Start an interactive coding session (full-screen TUI on TTY)
bun run synax -- chat

# Plain fallback
bun run synax -- chat --plain

# Run one bounded edit-capable task; --yes accepts previewed replacement edits
bun run synax -- run --task "Fix the failing test" --yes

# Constrain the task surface
bun run synax -- run --mode read-only --task "Inspect the command registry and identify one safe improvement. Do not modify files."
bun run synax -- run --mode patch --task "Make one minimal docs-only wording improvement in README.md, then run bun run typecheck."

# Show config
bun run synax -- config show
```

The full-screen chat TUI uses Synax's built-in TypeScript line renderer. Use `--plain` when you need the non-TUI fallback.

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
max_tool_calls = 96

[verification]
defaultCommand = "bun run typecheck"

[active]
provider = "relay"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
thinking = "off"

[providers.relay]
enabled = true
base_url = "http://127.0.0.1:1234/v1"
tool_call_parser = "qwen3_xml"

[providers.deepseek]
enabled = true
api_key_env = "DEEPSEEK_API_KEY"
input_price_per_1m_tokens = 0.27
output_price_per_1m_tokens = 1.10

[tools]
exposed = ["read", "write", "edit", "bash"]
shell = "zsh"

[tools.bash]
enabled = true
```

Thinking levels (`off`, `low`, `medium`, `high`, `xhigh`, `auto`) control extended reasoning for models that support it.

Environment overrides:

```sh
SYNAX_CONTEXT_BUDGET_TOKENS=65536
SYNAX_MAX_TOOL_CALLS=64
```

## Native Tool-Call Parsers

Local models rarely emit clean OpenAI-format `tool_calls`. Synax ships native parsers for 26 model families — Qwen XML, Hermes, Llama 3 JSON, Llama 4 Pythonic, DeepSeek, Mistral, OLMo3, Granite, InternLM, and more.

No vLLM runtime normalization required. Synax extracts tool calls from raw model output whether the format is XML tags, JSON blocks, Pythonic function syntax, or special-token-delimited markup.

Configure per-provider:

```toml
[provider]
tool_call_parser = "qwen3_xml"
```

Or let Synax auto-detect from your model name. See `docs/guide/tool-call-parsing.md`.

## Agent Loop

Synax manages context as a runtime discipline, not just a model instruction:

- **Budget model**: Approximate token estimation (chars/3). Compaction triggers at ~60% of effective limit.
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
| `bash`  | Run terminal commands, including git            |

The model loop stops when the model returns a final answer, hits the configured model-step limit, hits the configured tool-call limit, or encounters a tool/provider error.

`synax run --plan plan.md` is currently a placeholder. Native Anthropic protocol support, browser UI, IDE integration, databases, Docker infrastructure, and parallel agents are out of scope.

## Examples

| Example | Description |
|---------|-------------|
| [hello-world-extension](examples/hello-world-extension/) | SKILL.md + EventBus subscriber demonstrating the extension system |

## Docs

- [Getting Started](docs/guide/getting-started.md) — installation and first run
- [Architecture](docs/guide/architecture.md) — module diagram, responsibilities, data flow
- [Extensions](docs/guide/extensions.md) — EventBus, custom tools, parsers, repairers, recovery recipes
- [Configuration](docs/guide/configuration.md) — config files, environment variables
- [Commands](docs/guide/commands.md) — CLI command reference
- [Agent Loop & Tools](docs/guide/agent-loop.md) — tool surface and loop behavior
- [Tool-Call Parsing](docs/guide/tool-call-parsing.md) — parser configuration and model support
- [MCP](docs/guide/mcp.md) — Model Context Protocol bridge
- [Skills](docs/guide/skills.md) — SKILL.md format and discovery

## Docs Site

The formatted documentation lives in `docs/` and is built with VitePress:

```sh
bun run docs:dev
bun run docs:build
bun run docs:preview
```

GitHub Pages deployment is configured in `.github/workflows/pages.yml`. In the GitHub repository settings, set Pages source to GitHub Actions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, how to add handlers/parsers/recipes, and the PR checklist.

Quick start:

```sh
git clone git@github.com:achuthanmukundan00/synax.git
cd synax
bun install --frozen-lockfile
bun run build
bun run test
```

## Development

```sh
bun run typecheck
bun run lint
bun run test
bun run build
```

## Provider Smoke Tests

Live smoke tests verify end-to-end connectivity. Requires API keys for cloud providers:

```sh
SYNAX_LIVE_PROVIDER=relay bun run smoke:provider
SYNAX_LIVE_PROVIDER=deepseek bun run smoke:provider
SYNAX_LIVE_PROVIDER=anthropic bun run smoke:provider
SYNAX_LIVE_PROVIDER=openrouter bun run smoke:provider
SYNAX_LIVE_PROVIDER=groq bun run smoke:provider
```

## Self-Development Smoke Tests

```sh
bun run synax -- run --mode read-only --task "Inspect README.md and summarize Synax in 5 bullets. Do not modify files."
bun run synax -- run --mode patch --task "Make one minimal docs-only wording improvement in README.md, then run bun run typecheck."
bun run synax -- inspect
bun run synax -- doctor --full
```

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
