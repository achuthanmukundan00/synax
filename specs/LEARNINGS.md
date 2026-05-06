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

- A read-before-edit gate is much stronger when the ledger stores exact prior read text, not just file names or line ranges. That lets replacement edits fail closed on stale or uninspected text instead of guessing.

- Task modes need to constrain both the advertised tool surface and the actual execution gate. Hiding write/edit from the model is not enough if the runner still accepts those tool calls.

- Plain-text run reports are easier to trust when they surface budgets, files read, checkpoint IDs, and verification state in one bounded summary rather than dumping raw JSON.

- For non-interactive edit-capable runs, "preview before write" needs an explicit decision policy. Using `--yes` as the accept signal lets `synax run --task` fail closed on replacement edits without adding a prompt loop or changing the model-facing tool shape.

- Planning checklists are easier to keep truthful when completed slices are separated from release-gating verification. Prior successful test runs should stay in `PROGRESS.md` as historical evidence, while unfinished specs should keep final verification boxes open until the milestone is complete.

- The v0.6 extension surface can start as TypeScript contracts only. Keeping MCP bridge concepts policy-shaped before adding runtime behavior helps avoid accidental plugin-marketplace or unrestricted-tool assumptions.

- Self-hosting docs access can stay small and deterministic by using an explicit docs/spec/config-example allowlist plus the existing unsafe-path policy, rather than introducing embeddings or broad repository crawling.

- Exposing local docs through `synax inspect` keeps the first self-hosting surface deterministic and inspectable. Listing recognized docs first, then reading a single bounded docs/spec file, is enough for useful spec navigation without adding embeddings or model-facing tool expansion yet.

- Synax's existing fallback parser silently ignored malformed `<tool_call>` JSON blocks by returning no parsed calls. v0.4 needs explicit parser failure results so that later agent/client code can distinguish "no tool call" from "model attempted a malformed tool call."

- Native OpenAI-compatible `message.tool_calls` can fail in the same way as text-shaped local-model calls when `function.arguments` is malformed. The LLM client needs to consume typed parser failures directly; otherwise a `finish_reason: "tool_calls"` response can degrade into a normal final answer with zero parsed calls.
