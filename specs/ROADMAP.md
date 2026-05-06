# Roadmap

This roadmap is planning material. It describes intended work and must not be read as implemented behavior.

## Execution Snapshot

As of 2026-05-05, all five numbered specs are in progress rather than untouched drafts:

- v0.4 has an initial typed parser result surface and malformed `<tool_call>` diagnostics. The remaining work is full parser survival: reasoning sanitization, unknown/ambiguous rejection, broader fixtures, runtime-wide failure handling, docs, and diagnostics.
- v0.5 has bounded internal docs/spec discovery and reads. The remaining work is exposing that context through CLI/model paths, deterministic docs search, docs-impact checks, and self-hosting workflow docs.
- v0.6 has internal TypeScript extension interfaces and documented MCP groundwork. The remaining work is minimal built-in wiring/registry tests and concrete MCP policy-boundary tests.
- v0.7 has visible patch previews before validated replacement edits. The remaining work is accept/reject, atomicity proof, rollback, checkpoints, dirty-tree handling, optional worktree mode, run logs, verification profiles, and bounded repair loops.
- v1.0 has a public compatibility report format. The release remains blocked on finishing or explicitly descoping the remaining v0.4-v0.7 work and recording a concrete local Relay-compatible smoke result or skip rationale.

## v0.4 Tool-Call Survival

Detailed spec: [001-v0.4-tool-call-survival.md](001-v0.4-tool-call-survival.md)

Goal: Make Synax robust against common local-model tool-call and structured-output failures.

Required features:

- Harden the existing tool-call parsing path into a dedicated parser/normalizer.
- Support native OpenAI `message.tool_calls`.
- Support `<tool_call>{...}</tool_call>` blocks.
- Support unambiguous fenced JSON tool calls.
- Accept arguments as objects or stringified JSON.
- Sanitize leaked reasoning/thinking tags before final rendering or tool parsing.
- Reject unknown tools and fail safely on ambiguous tool calls.
- Add parser torture fixtures and compatibility diagnostics.
- Document Qwen/Unsloth GGUF, llama.cpp, and Relay expectations.

Non-goals:

- Full MCP
- Full TUI
- Intelligent compaction
- Provider rewrite

Acceptance checks:

- Parser tests cover valid, malformed, ambiguous, unknown, and reasoning-leak cases.
- Existing CLI and agent tests pass.
- Docs describe supported and rejected local-model formats.
- Diagnostic or smoke path reports parser/provider compatibility clearly.

## v0.5 Self-Hosting Docs + Spec Execution

Detailed spec: [002-v0.5-self-hosting-docs-spec-execution.md](002-v0.5-self-hosting-docs-spec-execution.md)

Goal: Make Synax better at modifying itself and executing its own specs without embeddings or external project-management systems.

Required features:

- Local docs provider for `README.md`, `docs/**`, `AGENTS.md`, `CHANGELOG.md` if present, `specs/**`, and config examples.
- Simple docs search/read capability.
- Plan/spec execution support, such as `synax run --plan specs/...`, if it fits the CLI architecture.
- Docs impact checker for source/config/CLI/tool behavior changes.
- Self-hosting workflow that updates progress and learnings.

Non-goals:

- Full RAG system
- Embeddings requirement
- Autonomous long-running project management
- MCP dependency

Acceptance checks:

- Synax can inspect a spec, related docs, and relevant code in bounded context.
- Plan/spec execution is either implemented or explicitly rejected by the detailed design.
- Docs-impact tests or smoke checks cover changed public behavior.
- `specs/PROGRESS.md` and `specs/LEARNINGS.md` have clear update points.

## v0.6 Extension Kernel + MCP Bridge Groundwork

Detailed spec: [003-v0.6-extension-kernel-mcp-groundwork.md](003-v0.6-extension-kernel-mcp-groundwork.md)

Goal: Define stable extension seams and lay safe groundwork for MCP without creating a plugin marketplace.

Required features:

- Minimal TypeScript interfaces for parser, repairer, sanitizer, provider adapter, context provider, verifier, docs provider, renderer, and MCP bridge.
- Internal registry or wiring pattern.
- Native Synax tool-to-MCP export concept.
- Guarded MCP tool import concept.
- Docs/specs as MCP resources concept.
- Prompt packs as MCP prompts concept.
- Safety policy that MCP cannot bypass Synax guardrails.

Non-goals:

- Arbitrary plugin marketplace
- Dynamic remote code execution
- Broad MCP server implementation
- Unrestricted shell through MCP

Acceptance checks:

- Interfaces are documented and tested at compile time.
- Built-in implementations still work through the minimal wiring.
- MCP bridge design preserves tool policy, approval/checkpoint policy, verification, and budget boundaries.

## v0.7 Daily-Driver Safety

Detailed spec: [004-v0.7-daily-driver-safety.md](004-v0.7-daily-driver-safety.md)

Goal: Make Synax safe enough for routine repo work.

Required features:

- Patch preview.
- Accept/reject flow.
- Atomic patch application.
- `/diff`.
- `/undo-last-edit` or equivalent.
- Git checkpoint before run/task.
- Dirty tree handling.
- Optional worktree mode.
- Run logs under `.synax/runs/` or equivalent.
- Verification profiles and bounded repair loop.
- Readable status summaries.

Non-goals:

- Full fancy TUI if simple CLI flows are enough
- Autonomous unbounded editing
- Destructive git operations without explicit user command

Acceptance checks:

- Users can review and reject edits before application.
- Failed edits do not leave partial files.
- A bounded rollback path exists for the last edit/task.
- Dirty tree behavior is documented and tested.
- Verification profiles run predictably.

## v1.0 Local Coding Agent Runtime

Detailed spec: [005-v1.0-local-coding-agent-runtime.md](005-v1.0-local-coding-agent-runtime.md)

Goal: Ship Synax as a reliable local coding-agent runtime for developers using local models.

Required features:

- Reliable Relay/OpenAI-compatible local endpoint operation.
- Local Qwen/Unsloth GGUF compatibility proven by diagnostics or documented smoke reports.
- Tool-call survival from v0.4.
- Self-docs/spec access from v0.5.
- Extension interfaces and guarded MCP groundwork from v0.6.
- Patch preview, checkpoint, rollback, and verification safety from v0.7.
- Compatibility matrix or diagnostic report format.
- Public docs that explain local-model-first positioning.

Non-goals:

- Promise to beat Codex on frontier-model intelligence
- Cloud-agent clone positioning
- Full intelligent compaction
- Unrestricted autonomy

Acceptance checks:

- Release checklist passes.
- Public docs match implemented behavior.
- Compatibility report format exists.
- Core workflows work without OpenAI-hosted APIs.

## v1.1 Intelligent Compaction

Goal: Add intelligent compaction only after v1.0 reliability and safety are proven.

Required features:

- To be specified after v1.0.

Non-goals:

- Do not pull v1.1 compaction into v0.4-v1.0 unless explicitly rescheduled.

Acceptance checks:

- To be specified in a future spec.
