# Providers

Synax supports OpenAI-compatible and Anthropic-compatible providers.
You can configure multiple providers and switch between them at runtime.

## Provider Compatibility

| Type | Description |
|------|-------------|
| `openai-compatible` | Any service with an OpenAI-compatible `/v1/chat/completions` endpoint |
| `anthropic-compatible` | Any service with an Anthropic-compatible `/v1/messages` endpoint |

## Built-in Provider Presets

Synax ships with defaults for common providers:

| Preset | Base URL | Notes |
|--------|----------|-------|
| Relay Local | `http://127.0.0.1:1234/v1` | Local llama.cpp / Relay server |
| Relay Cloudflare | `https://ai.watchyourtemper.com/v1` | Cloudflare Tunnel + Relay |
| OpenAI | `https://api.openai.com/v1` | Requires `OPENAI_API_KEY` |
| Anthropic | `https://api.anthropic.com` | Requires `ANTHROPIC_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | Requires `OPENROUTER_API_KEY` |

## Configuring a Provider

### Local Relay Provider

```toml
[active]
provider = "relay-local"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"

[providers.relay-local]
enabled = true
name = "Relay Local"
compatibility = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"

[[providers.relay-local.models]]
id = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
display_name = "Qwen3.6 35B Local"
context_window = 88000
supports_thinking = false
```

### Cloud Provider (OpenAI-compatible)

```toml
[active]
provider = "deepseek"
model = "deepseek-chat"

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

### Custom OpenAI-Compatible Provider

```toml
[providers.custom]
enabled = true
name = "My Custom Endpoint"
compatibility = "openai-compatible"
base_url = "https://my-inference.example.com/v1"
api_key_env = "CUSTOM_API_KEY"

[providers.custom.headers]
"X-Custom-Header" = "value"

[[providers.custom.models]]
id = "my-model"
context_window = 65536
supports_thinking = false
```

### Anthropic-Compatible Provider

```toml
[providers.claude]
enabled = true
name = "Claude via Proxy"
compatibility = "anthropic-compatible"
base_url = "https://anthropic-proxy.example.com/v1"
api_key_env = "ANTHROPIC_API_KEY"

[[providers.claude.models]]
id = "claude-sonnet-4-5"
context_window = 200000
supports_thinking = true
thinking_levels = ["off", "low", "medium", "high"]
default_thinking = "medium"
```

## API Key Configuration

Prefer `api_key_env` over `api_key`. The environment variable is never written to disk.

```toml
api_key_env = "OPENAI_API_KEY"  # reads from process.env.OPENAI_API_KEY
```

Only use `api_key` for local servers that don't need auth:

```toml
api_key = "sk-no-key-required"  # local relay servers
```

## Custom Headers

Headers can reference environment variables using `${VAR_NAME}` syntax:

```toml
[providers.relay-local.headers]
"CF-Access-Client-Id" = "${CF_ACCESS_CLIENT_ID}"
"CF-Access-Client-Secret" = "${CF_ACCESS_CLIENT_SECRET}"
```

## Model Configuration

Each provider can declare multiple models:

```toml
[[providers.deepseek.models]]
id = "deepseek-chat"
display_name = "DeepSeek V3"
context_window = 128000
supports_thinking = false

[[providers.deepseek.models]]
id = "deepseek-reasoner"
display_name = "DeepSeek R1"
context_window = 128000
supports_thinking = true
thinking_levels = ["off", "low", "medium", "high", "auto"]
default_thinking = "auto"
```

### Thinking Levels

When a model supports thinking:

| Level | Description |
|-------|-------------|
| `off` | No thinking/reasoning tags |
| `low` | Minimal reasoning |
| `medium` | Balanced reasoning |
| `high` | Extended reasoning |
| `auto` | Model decides |

Models that don't support thinking will show `"n/a"` in the settings menu.

## Testing Provider Connection

From the TUI, type `/test-provider` to probe the active provider's models and chat endpoints.

## Switching Providers in the TUI

1. Press `/` and type `settings`
2. Navigate to the **Model** tab
3. Select **Active Provider** and choose from enabled providers
4. Select **Active Model** to pick a model from that provider
5. Changes persist automatically
