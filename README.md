# Synax

[![CI](https://github.com/achuthanmukundan00/synax/actions/workflows/ci.yml/badge.svg)](https://github.com/achuthanmukundan00/synax/actions/workflows/ci.yml)

Synax is a TypeScript-first local coding agent for developers running local LLMs through Relay or another OpenAI-compatible gateway.

It is CLI-first, local-first, and built for constrained local models. Synax keeps model-visible context, tool calls, command output, and file edits bounded and inspectable.

## What Synax Is

- A local-first CLI coding agent with multi-provider routing.
- A Relay-compatible OpenAI-style chat client with Anthropic Messages support.
- A bounded file inspection, edit, and verification loop.
- Native tool-call parsers for 26 model families — no vLLM normalization needed.
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
npm run synax -- doctor
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

# Start an interactive coding session (full-screen TUI on TTY)
npm run synax -- chat

# Plain fallback
npm run synax -- chat --plain

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
defaultCommand = "npm run typecheck"

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

## Provider Smoke Tests

Live smoke tests verify end-to-end connectivity. Requires API keys for cloud providers:

```sh
SYNAX_LIVE_PROVIDER=relay npm run smoke:provider
SYNAX_LIVE_PROVIDER=deepseek npm run smoke:provider
SYNAX_LIVE_PROVIDER=anthropic npm run smoke:provider
SYNAX_LIVE_PROVIDER=openrouter npm run smoke:provider
SYNAX_LIVE_PROVIDER=groq npm run smoke:provider
```

## Self-Development Smoke Tests

```sh
npm run synax -- run --mode read-only --task "Inspect README.md and summarize Synax in 5 bullets. Do not modify files."
npm run synax -- run --mode patch --task "Make one minimal docs-only wording improvement in README.md, then run npm run typecheck."
npm run synax -- inspect
npm run synax -- doctor --full
```

## License

Apache 2.0
