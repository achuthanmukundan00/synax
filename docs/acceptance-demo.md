# Synax v0.1 Acceptance Demo

This demo is deterministic except for the live model response. It is designed for a local OpenAI-compatible endpoint such as llama.cpp serving an Unsloth Qwen3.6 GGUF.

## Fixture

The fixture lives in `fixtures/acceptance/basic-ts`. It contains one failing test:

```sh
cd fixtures/acceptance/basic-ts
npm test
```

Expected failure: `add(2, 3)` returns `4` instead of `5`.

## Local Model Setup

Run an OpenAI-compatible server that supports Chat Completions tools. For Unsloth Qwen3.6 GGUFs, prefer a llama.cpp-compatible backend with the model chat template enabled. Unsloth documents Qwen-family tool calling through OpenAI-compatible `tools` and `tool_choice: "auto"` requests, with tool results returned as `role: "tool"` messages.

Example `.synax.toml`:

```toml
model = "qwen3.6-local"
baseUrl = "http://127.0.0.1:1234/v1"

[agent]
# 16000 is minimal/safe, 65536 is normal, and 131072 is a high-context
# local profile for capable llama.cpp setups.
context_budget_tokens = 131072
max_model_steps = 32
max_tool_calls = 96

[verification]
defaultCommand = "npm test"

[provider]
kind = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
model = "qwen3.6-local"
api_key = "sk-no-key-required"
```

## Patch Demo

From the fixture directory:

```sh
synax run --task "Fix the failing add test. Inspect files before editing." --yes
```

The report must show:

- Context ledger summary.
- Changed file list.
- A `replace_in_file` diff before application.
- One verification command and result.

## Safe Failure Fixtures

These failure states are covered by tests and can be reproduced without a model server:

- Malformed or non-standard tool calls: `src/__tests__/agent-flow.test.ts`.
- Unread-file patch rejection: `src/__tests__/agent-flow.test.ts`.
- No-match and multi-match replacement rejection: `src/__tests__/agent-flow.test.ts`.
- Verification failure reporting: `src/__tests__/agent-flow.test.ts`.
- Provider failures and context budget failures: `src/__tests__/llm-client.test.ts`.

## Protocol Notes

Synax sends OpenAI-compatible tool definitions:

```json
{
  "type": "function",
  "function": {
    "name": "read_file_range",
    "description": "Read file ranges",
    "parameters": { "type": "object" }
  }
}
```

It accepts both standard `message.tool_calls` responses and Qwen-style text fallback blocks:

```txt
<tool_call>{"name":"read_file_range","arguments":{"path":"src/math.ts"}}</tool_call>
```

Native Anthropic provider support is not part of v0.1. Synax includes Anthropic-compatible tool schema mapping helpers so the tool boundary remains explicit if that provider is added later.
