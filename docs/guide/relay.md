# Relay Setup

Relay is the preferred inference path for Synax. Synax expects an OpenAI-compatible API rooted at a base URL such as:

```txt
http://127.0.0.1:1234/v1
```

The important endpoints are:

- `GET /models`
- `POST /chat/completions`

## Local Relay Profile

Use `.synax.toml`:

```toml
[agent]
context_budget_tokens = 131072
max_model_steps = 64
max_tool_calls = 192

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
exposed = ["read", "write", "edit", "bash"]
shell = "zsh"
unsafe = false

[tools.bash]
enabled = true
```

Set `model` to the exact ID Relay reports from `/models`.

## Provider Presets

Synax currently normalizes these provider presets:

| Preset                     | Use                                              |
| -------------------------- | ------------------------------------------------ |
| `relay-local`              | Default local Relay endpoint at `127.0.0.1:1234` |
| `relay-cloudflare`         | Relay behind Cloudflare Access headers           |
| `openai`                   | OpenAI-compatible cloud endpoint                 |
| `anthropic`                | Experimental OpenAI-compatible config shape only |
| `openrouter`               | OpenRouter-compatible endpoint                   |
| `custom-openai-compatible` | Any custom OpenAI-compatible server              |

Normal local use should not require OpenAI-hosted APIs.

## Headers And Keys

Local Relay usually accepts a dummy key:

```toml
[provider]
api_key = "sk-no-key-required"
```

For environment-backed keys:

```toml
[provider]
api_key_env = "OPENROUTER_API_KEY"
```

For custom headers:

```toml
[provider.custom_headers]
"X-Example-Header" = "value"
```

Environment references are supported in custom header values:

```toml
[provider.custom_headers]
"CF-Access-Client-Id" = "$SYNAX_CF_ACCESS_CLIENT_ID"
"CF-Access-Client-Secret" = "$SYNAX_CF_ACCESS_CLIENT_SECRET"
```

Synax does not log API keys.

## Testing Relay From Synax

```sh
npm run synax -- doctor --full
```

Or inside chat:

```txt
synax> /test-provider
```

Expected healthy output includes a reachable models endpoint and a passing smoke chat request. Some OpenAI-compatible servers do not expose `/models`; in that case the chat request is the authoritative check.

## Runtime Overrides

Inside `synax chat`, settings changes are session-only:

```txt
/settings set provider.endpoint http://127.0.0.1:1234/v1
/settings set provider.model Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf
/settings set provider.header.Authorization Bearer sk-no-key-required
/settings set agent.context_budget_tokens 65536
/settings set agent.max_model_steps 24
/settings set agent.max_tool_calls 64
```
