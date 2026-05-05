# Synax PRD

## Product Name

Synax

## Manifesto

The de-facto coding agent for devs running local models on consumer GPUs.

## Target Users

- Developers running local or self-hosted LLMs through Relay, llama.cpp, or OpenAI-compatible gateways.
- Developers who want a CLI coding agent that can work without cloud-only assumptions.
- Developers who need bounded repo edits, visible verification, and practical behavior on constrained consumer hardware.

## Core Problem

Local inference is useful but messy. Local models and gateways may emit malformed tool calls, invalid JSON, leaked reasoning tags, mixed final answers, provider-specific quirks, or incomplete structured output. Generic cloud-agent assumptions break down when the model is smaller, slower, less tool-trained, or running through a compatibility gateway.

Synax should make local models usable for real software work by adding compatibility, recovery, safety boundaries, and verification around the model.

## Differentiation

Synax is not a generic cloud coding agent clone. It is the compatibility-and-control layer between messy local inference and real repo work:

- local-model-first, not cloud-first
- Relay/OpenAI-compatible by default
- tolerant of malformed local-model output
- CLI-first and inspectable
- bounded file and shell behavior
- verification-driven instead of autonomy-driven
- small TypeScript codebase intended to be understandable

## Non-Goals

- Hosted SaaS agent platform
- IDE extension as the primary product
- Browser dashboard or web UI
- Persistent memory database
- Vector-search-first architecture
- Plugin marketplace
- Docker infrastructure by default
- Parallel autonomous agent swarm
- Beating frontier hosted agents on raw intelligence

## Core Product Pillars

1. Local-model tolerance: Synax should safely parse, normalize, reject, or recover from common local-model output failures.
2. Consumer-GPU ergonomics: Synax should respect context, latency, model-step limits, and constrained runtime behavior.
3. Relay/OpenAI-compatible local endpoint support: Relay and compatible `/v1/chat/completions` servers should remain the preferred path.
4. Safe bounded repo editing: File reads, edits, writes, git inspection, and shell behavior should be policy-bound and inspectable.
5. Verification-driven operation: Synax should run configured checks and report results instead of claiming success from model confidence.
6. Extension points without plugin soup: Extension interfaces should be stable and minimal before any broad plugin ecosystem exists.
7. Self-hosting docs/code workflow: Synax should be able to inspect its own specs, docs, and code so future Synax agents can execute planned work.

## v1.0 Success Criteria

- Synax works reliably with local Qwen/Unsloth GGUF models through Relay or another OpenAI-compatible local endpoint.
- Common malformed tool-call outputs are either recovered safely or rejected with useful diagnostics.
- Repo editing is bounded, previewable, and reversible enough for daily use.
- Verification profiles are documented and usable from the CLI.
- Specs, docs, and current project context are accessible to Synax without embeddings or cloud services.
- Extension interfaces are documented and tested.
- MCP groundwork, if enabled, preserves Synax tool policy, approval policy, verification, and budget boundaries.
- Public docs clearly position Synax as local-model-first and do not overpromise cloud-agent parity.
