# Configuration

Synax loads configuration from:

1. Built-in defaults.
2. Global user config at `~/.config/synax/config.toml`, when present.
3. The nearest project `.synax.toml`.
4. Supported environment overrides.

Project config wins over global config.

## Default Local Shape

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

## Environment Overrides

These override agent budget fields:

```sh
SYNAX_CONTEXT_BUDGET_TOKENS=65536
SYNAX_MAX_MODEL_STEPS=24
SYNAX_MAX_TOOL_CALLS=64
```

Provider keys can be read through `api_key_env`:

```toml
[provider]
api_key_env = "OPENROUTER_API_KEY"
```

## Inspect Config

```sh
npm run synax -- config show
npm run synax -- config get provider.model
npm run synax -- config get provider.baseUrl --json
```

Initialize a config:

```sh
npm run synax -- config init
```

`config init --force` is accepted by the CLI, but current file protection still refuses to overwrite an existing `.synax.toml`. Edit existing configs directly.

## Validation

Synax validates basic shape and types. Unsupported provider kinds fail validation. For v0.3, the operational provider kind is:

```toml
kind = "openai-compatible"
```

Native Anthropic protocol support is not implemented.
