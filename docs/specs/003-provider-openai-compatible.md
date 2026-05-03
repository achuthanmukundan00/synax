# Implement OpenAI-compatible provider client and Relay-friendly configuration

GitHub labels: `type:feature`, `area:provider`, `priority:p0`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/3

Local spec mirror: `docs/specs/003-provider-openai-compatible.md`

## Problem

Synax targets local models through OpenAI-compatible endpoints. Provider support must be clean enough to use Relay but not coupled to Relay.

## Scope

Implement the v0.1 provider abstraction and OpenAI-compatible Chat Completions client.

## Requirements

- Read provider config from `.synax.toml`.
- Support `kind = "openai-compatible"`.
- Support `base_url`, `model`, `api_key`, and optional custom headers.
- Send Chat Completions requests to local OpenAI-compatible servers.
- Treat Relay as the recommended local path, not a hard dependency.
- Return structured provider errors with enough detail for `synax doctor`.
- Avoid Anthropic Messages support in v0.1 unless it is transparently handled through an OpenAI-compatible layer.

## Acceptance Criteria

- A minimal prompt can be sent to a configured OpenAI-compatible endpoint.
- Missing or malformed provider config produces a clear error.
- Provider errors preserve HTTP status and concise response details when available.
- API key may be empty for local endpoints.
- Custom headers are included when configured.

## Out Of Scope

- Native Anthropic provider support.
- Provider plugin architecture.
- Streaming UI polish.
- Cloud provider-specific account flows.
