# Learnings Log

Use this file to capture facts learned while testing Synax against local models, gateways, parser failures, and real repo workflows. Keep entries concrete and dated when possible.

## Categories

- Local model quirks
- Qwen/Unsloth GGUF behavior
- Relay/llama.cpp compatibility notes
- Codex/Synax agent workflow lessons
- Parser failures seen in practice
- Verification lessons
- Things to avoid

## Seed Assumptions

- Many existing agents assume clean provider-native tool calls.
- Local GGUF models often emit text-shaped or malformed tool calls.
- Reasoning/thinking leakage must be sanitized.
- Ambiguous tool calls should fail safely.
- Synax should prefer conservative recovery over reckless execution.

## Things To Avoid

- Treating malformed tool-call recovery as permission to execute uncertain actions.
- Hiding parser failures behind generic provider errors.
- Logging full prompts, API keys, or leaked reasoning by default.
- Adding embeddings, MCP, TUI, or broad provider rewrites before v0.4 reliability is proven.

## 2026-05-05

- The v0.6 extension surface can start as TypeScript contracts only. Keeping MCP bridge concepts policy-shaped before adding runtime behavior helps avoid accidental plugin-marketplace or unrestricted-tool assumptions.

- Self-hosting docs access can stay small and deterministic by using an explicit docs/spec/config-example allowlist plus the existing unsafe-path policy, rather than introducing embeddings or broad repository crawling.

- Synax's existing fallback parser silently ignored malformed `<tool_call>` JSON blocks by returning no parsed calls. v0.4 needs explicit parser failure results so that later agent/client code can distinguish "no tool call" from "model attempted a malformed tool call."
