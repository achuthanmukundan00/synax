# Providers

Synax supports OpenAI-compatible and Anthropic Messages providers.
You can configure multiple providers and switch between them at runtime.

## Provider Protocols

| Protocol             | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `openai-compatible`  | Any service with an OpenAI-compatible `/chat/completions` endpoint |
| `anthropic-messages` | Real Anthropic Messages API adapter via `/v1/messages`             |

## Built-in Provider Presets

Synax ships with presets for these providers:

| Provider ID  | Protocol           | Base URL                         | Auth                 |
| ------------ | ------------------ | -------------------------------- | -------------------- |
| `relay`      | openai-compatible  | `http://127.0.0.1:1234/v1`       | none                 |
| `custom`     | openai-compatible  | user-configured                  | optional             |
| `deepseek`   | openai-compatible  | `https://api.deepseek.com/v1`    | `DEEPSEEK_API_KEY`   |
| `openrouter` | openai-compatible  | `https://openrouter.ai/api/v1`   | `OPENROUTER_API_KEY` |
| `groq`       | openai-compatible  | `https://api.groq.com/openai/v1` | `GROQ_API_KEY`       |
| `anthropic`  | anthropic-messages | `https://api.anthropic.com`      | `ANTHROPIC_API_KEY`  |
| `mistral`    | openai-compatible  | `https://api.mistral.ai/v1`      | `MISTRAL_API_KEY`    |
| `together`   | openai-compatible  | `https://api.together.xyz/v1`    | `TOGETHER_API_KEY`   |

OpenAI-compatible providers (relay, custom, deepseek, openrouter, groq, mistral, together) share
one client implementation. Anthropic uses a real Messages API adapter.

## Configuring a Provider

### Local Relay

```toml
[provider]
provider = "relay"
base_url = "http://127.0.0.1:1234/v1"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
context_window = 131072
```

### DeepSeek

```toml
[provider]
provider = "deepseek"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"
context_window = 64000
# Optional: override token pricing (defaults are preset)
input_price_per_1m_tokens = 0.27
output_price_per_1m_tokens = 1.10
```

### OpenRouter

```toml
[provider]
provider = "openrouter"
model = "deepseek/deepseek-chat"
api_key_env = "OPENROUTER_API_KEY"
context_window = 64000

[provider.headers]
HTTP-Referer = "https://github.com/achuthanmukundan00/synax"
X-Title = "Synax"
```

OpenRouter automatically adds `HTTP-Referer` and `X-Title` default headers.
You can override or add custom headers in the `[provider.headers]` section.

### Groq

```toml
[provider]
provider = "groq"
model = "llama-3.3-70b-versatile"
api_key_env = "GROQ_API_KEY"
context_window = 128000
```

### Anthropic (real Messages adapter)

```toml
[provider]
provider = "anthropic"
model = "claude-sonnet-4-5-20250929"
api_key_env = "ANTHROPIC_API_KEY"
context_window = 200000
```

Anthropic uses the real Messages API (`POST /v1/messages`) with `x-api-key`
auth, not the OpenAI-compatible format. System prompts map to the top-level
`system` field. Tool use is not yet supported for Anthropic.

### Custom OpenAI-compatible

```toml
[provider]
provider = "custom"
base_url = "http://127.0.0.1:1234/v1"
model = "local-model"
api_key = "dummy"
context_window = 131072
```

### Legacy Relay (backward compatible)

Your existing Relay/local config keeps working:

```toml
[provider]
kind = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
```

## API Key Configuration

Prefer `api_key_env` over `api_key`. The environment variable is never written to disk.

```toml
api_key_env = "DEEPSEEK_API_KEY"  # reads from process.env.DEEPSEEK_API_KEY
```

Only use `api_key` for local servers that don't need auth:

```toml
api_key = "sk-no-key-required"  # local relay servers
```

## Token Pricing & Session Spend

Cloud providers have preset token pricing. You can override pricing in config:

```toml
[provider]
provider = "deepseek"
input_price_per_1m_tokens = 0.27   # USD per 1M input tokens
output_price_per_1m_tokens = 1.10  # USD per 1M output tokens
```

Default pricing per provider:

| Provider   | Input ($/1M) | Output ($/1M) |
| ---------- | ------------ | ------------- |
| DeepSeek   | $0.27        | $1.10         |
| Groq       | $0.59        | $0.79         |
| Anthropic  | $3.00        | $15.00        |
| OpenRouter | varies       | varies        |

When pricing is configured, the TUI shows a session spend indicator
at the bottom of the screen: `Spend: $0.004`. Local providers show
`Spend: local`.

## Custom Headers

```toml
[provider.headers]
"HTTP-Referer" = "https://github.com/achuthanmukundan00/synax"
"X-Title" = "Synax"
"X-Custom" = "value"
```

## Model Configuration

Each provider supports context window configuration:

```toml
[provider]
provider = "deepseek"
model = "deepseek-chat"
context_window = 64000
```

## Live Provider Smoke Tests

Smoke tests verify end-to-end connectivity with real providers.
They require user-supplied API keys and are not run in CI.

```bash
# Test Relay (local)
SYNAX_LIVE_PROVIDER=relay bun run smoke:provider

# Test DeepSeek
SYNAX_LIVE_PROVIDER=deepseek bun run smoke:provider

# Test OpenRouter
SYNAX_LIVE_PROVIDER=openrouter bun run smoke:provider

# Test Groq
SYNAX_LIVE_PROVIDER=groq bun run smoke:provider

# Test Anthropic
SYNAX_LIVE_PROVIDER=anthropic bun run smoke:provider

# Test custom endpoint
SYNAX_LIVE_PROVIDER=custom SYNAX_CUSTOM_BASE_URL=http://127.0.0.1:1234/v1 bun run smoke:provider
```

Each smoke test sends a tiny prompt (`"Reply with exactly: synax-ok"`)
and verifies the response. Streaming is also tested. Tests are skipped
when required API keys are missing.

## Switching Providers

From the TUI:

1. Press `/` and type `settings`
2. Navigate to the **Model** tab
3. Select **Active Provider** and choose from enabled providers
4. Select **Active Model** to pick a model from that provider
5. Changes persist automatically

## Known Limitations

- Anthropic tool use is not yet supported. Requesting tools with an
  Anthropic provider will throw a clear error.
- Streaming is implemented in the shared OpenAI-compatible client but
  the Anthropic adapter only supports non-streaming requests.
- Mistral and Together are available as presets on the shared
  OpenAI-compatible client but lack dedicated smoke tests.
