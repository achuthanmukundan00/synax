# Compatibility Reports

Synax tracks local-model compatibility with explicit reports instead of broad claims. A report records one concrete smoke test against one provider, endpoint, model, and Synax version.

Use this page as the public format until Synax grows a generated `doctor` report. Mark unknown or untested fields as `unknown` or `not tested`; do not infer a pass from a similar model or gateway.

## Report Fields

| Field | Required | Value |
| --- | --- | --- |
| `synax_version` | Yes | Synax package version or commit hash used for the test. |
| `tested_at` | Yes | Date of the test in `YYYY-MM-DD` format. |
| `tester` | No | Person or automation that ran the smoke test. |
| `provider_gateway` | Yes | Gateway name, such as Relay, llama.cpp server, or another OpenAI-compatible server. |
| `provider_version` | No | Gateway version when known. Use `unknown` if unavailable. |
| `base_url` | Yes | Endpoint root, with host details redacted if needed. |
| `model` | Yes | Exact model ID reported by the gateway. |
| `quantization` | No | Quantization label when known, such as `IQ3_XXS`, `Q4_K_M`, or `unknown`. |
| `endpoint_compatibility` | Yes | `pass`, `partial`, `fail`, or `not tested`. |
| `native_tool_calls` | Yes | `pass`, `partial`, `fail`, or `not tested`. |
| `text_tool_calls` | Yes | `pass`, `partial`, `fail`, or `not tested`. |
| `reasoning_leakage` | Yes | `none observed`, `sanitized`, `leaked`, or `not tested`. |
| `max_context_tested` | No | Largest configured or observed context used during the smoke test. |
| `diagnostics` | Yes | Short pass/fail notes from `synax doctor --full`, chat, ask, run, or parser tests. |
| `caveats` | Yes | Known limitations, skipped checks, or local setup constraints. |

## Markdown Template

```md
## Provider / Model

- Synax version:
- Tested at:
- Tester:
- Provider gateway:
- Provider version:
- Base URL:
- Model:
- Quantization:
- Max context tested:

| Check | Result | Notes |
| --- | --- | --- |
| Endpoint compatibility | not tested |  |
| Native tool calls | not tested |  |
| Text-shaped tool calls | not tested |  |
| Reasoning leakage | not tested |  |

Diagnostics:

- `npm run synax -- doctor --full`: not run
- `synax chat` smoke test: not run
- `synax ask` smoke test: not run
- `synax run` edit smoke test: not run

Caveats:

- 
```

## JSON Shape

```json
{
  "synax_version": "0.3.0",
  "tested_at": "2026-05-05",
  "tester": "manual",
  "provider_gateway": "Relay",
  "provider_version": "unknown",
  "base_url": "http://127.0.0.1:1234/v1",
  "model": "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf",
  "quantization": "IQ3_XXS",
  "endpoint_compatibility": "not tested",
  "native_tool_calls": "not tested",
  "text_tool_calls": "not tested",
  "reasoning_leakage": "not tested",
  "max_context_tested": "unknown",
  "diagnostics": [],
  "caveats": ["Example only; not a verified compatibility result."]
}
```

## Current Matrix

| Provider / Gateway | Model | Status | Evidence |
| --- | --- | --- | --- |
| Relay | Qwen/Unsloth GGUF models | Assumed target | Product target documented in the PRD; no checked-in smoke report yet. |
| OpenAI-compatible custom server | Any local model | Assumed target | Config path exists; compatibility depends on endpoint and model behavior. |

Assumed target means Synax is designed for that path, not that the exact provider/model pair has passed a recorded smoke test. Add a dated report when a local endpoint is available and keep caveats visible.
