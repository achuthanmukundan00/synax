# Super Architecture

Super is the persistent living-agent daemon layer for the Synax ecosystem.

It is not a generic coding agent. It specializes Synax for career and life
operations: digest generation, careful memory consolidation, accountable
planning, and user-consented channel workflows.

## Runtime Flow

```txt
AutoCareer UI/API
  -> Super daemon
  -> Synax runtime
  -> Relay job queue
  -> llama.cpp or another local model server
```

## Packages

- `super-core`: world model, runtime prompt boundary, self-model patch suggestions.
- `super-daemon`: lifecycle, pulse, dream cycle, dedupe, reply fence, run lock.
- `super-channels`: Discord, GitHub, email, API, and future channel adapter contracts.
- `super-memory`: consolidation interfaces.
- `super-autocareer-adapter`: AutoCareer context and tool registration contracts.
- `apps/superd`: runnable daemon entrypoint.

## Boundaries

Super may depend on Synax. Synax must not depend on Super.

Super owns persistent daemon behavior, world docs, self model, pulse and dream
cycles, channel adapters, and patch suggestions.

Synax owns generic task orchestration, tools, memory adapters, handoff/subagents,
and LLM client abstractions.

## Synax SDK Boundary

Super calls Synax through `SuperSynaxSdkAdapter`. The adapter receives model,
memory, tool, and policy configuration and constructs a Synax SDK runtime at
run time. Super never imports Synax internals, parser code, TUI code, or coding
agent prompts.

`superd` reads the following optional environment variables:

- `SUPER_WORLD_ROOT`
- `SUPER_WORKING_DIR`
- `SUPER_SESSION_ID`
- `SUPER_LLM_PROVIDER`
- `SUPER_LLM_BASE_URL`
- `SUPER_LLM_MODEL`
- `SUPER_LLM_API_KEY`
- `SUPER_LLM_MAX_TOKENS`
- `SUPER_LLM_TIMEOUT_MS`
- `SUPER_SYNAX_MODE`
- `SUPER_ENABLE_BASH`

Without model configuration, the daemon can start and report status, but real
runs fail with a structured Synax SDK configuration error.
