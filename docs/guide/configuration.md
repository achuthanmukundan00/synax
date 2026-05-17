# Configuration

Synax uses a layered config system with clear precedence.

## Config Files

| Level    | Path                          | Purpose               |
| -------- | ----------------------------- | --------------------- |
| Defaults | Built-in                      | Safe fallback values  |
| Global   | `~/.config/synax/config.toml` | Machine-wide defaults |
| Local    | `<repo>/.synax.toml`          | Per-project overrides |

## Precedence

```
defaults → global config → local .synax.toml
```

Local always wins over global. Global always wins over defaults.

## Quick Start

```bash
# Generate a config in the current repo
synax config init

# Edit directly
vim .synax.toml
```

## Config Format (TOML)

### Active Provider and Model

```toml
[active]
provider = "relay"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
thinking = "off"
```

### Provider Definitions

```toml
[providers.relay]
enabled = true
name = "Relay"
compatibility = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"

[[providers.relay.models]]
id = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
display_name = "Qwen3.6 35B Local"
context_window = 131072
supports_thinking = false

[providers.deepseek]
enabled = true
name = "DeepSeek"
compatibility = "openai-compatible"
base_url = "https://api.deepseek.com/v1"
api_key_env = "DEEPSEEK_API_KEY"

[[providers.deepseek.models]]
id = "deepseek-chat"
display_name = "DeepSeek V3"
context_window = 128000
supports_thinking = false
```

### Custom Headers

```toml
[providers.relay.headers]
"X-Custom-Header" = "${MY_ENV_VAR}"
```

### Skills

Skill entries are filesystem paths. Use `~/...` for home-relative paths,
`./...` for project-relative, or absolute paths.

```toml
[skills]
enabled = ["~/.agents/skills/coderabbit-review"]
disabled = ["~/.agents/skills/grill-me"]
```

### MCP Servers

```toml
[mcp.servers.context7]
enabled = true
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
```

### TUI

```toml
[tui]
mouse = false
alternate_screen = true
cmux_mode = false
```

Set `cmux_mode = true` to reduce OpenTUI frame rate and retained live cards when running many parallel TUI sessions.

### AI Core Visual Profile

```toml
coreVisualProfile = "model"
```

Use `model` to choose the AI core morphology from the active model ID. You can also force one profile:

```toml
coreVisualProfile = "qwen"
```

Canonical values are lowercase: `model`, `default`, `qwen`, `openai`, `frontier`, `deepseek`, and `gemini`.
Synax also accepts `core_visual_profile` and legacy `[provider]`-scoped placement for compatibility.

## Legacy Format (backward compatible)

The single-provider format from v0.1-v0.3 is still supported:

```toml
[provider]
kind = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
api_key = "sk-no-key-required"
```

When both formats exist, the multi-provider format takes precedence for provider definitions. The legacy `provider.model` is used as a fallback for `active.model`.

## Environment Variables

| Variable                      | Purpose                 |
| ----------------------------- | ----------------------- |
| `SYNAX_CONTEXT_BUDGET_TOKENS` | Override context budget |
| `SYNAX_MAX_TOOL_CALLS`        | Override max tool calls |
| `DEEPSEEK_API_KEY`            | DeepSeek API key        |
| `OPENAI_API_KEY`              | OpenAI API key          |
| `ANTHROPIC_API_KEY`           | Anthropic API key       |

## Validation

Invalid config is NOT silently ignored. Parse errors produce clear messages:

```
[synax] Config error:
providers.my-provider: base_url is required
active.thinking: must be one of: off, low, medium, high, auto
```

## Setting Config from the TUI

Press `/` in the TUI and type `settings` to open the settings menu.
Use the Model tab to change provider, model, and thinking levels.
Use the Providers tab to view configured providers.
Changes persist to the local `.synax.toml` if one exists, otherwise to the global config.
