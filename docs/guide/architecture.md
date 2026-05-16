# Architecture

Synax is a TypeScript-first local coding agent built as a modular pipeline. This document describes the runtime architecture, module responsibilities, data flow, and extension points.

## High-Level Diagram

```
                         ┌─────────────────────────────────────────┐
                         │              CLI (src/cli.ts)            │
                         │  chat | ask | run | inspect | config     │
                         │  doctor                                  │
                         └────────────────┬────────────────────────┘
                                          │
                         ┌────────────────▼────────────────────────┐
                         │           Session (src/session/)          │
                         │  Boot → trustGate → Ready → Running      │
                         │  Owns: config, tools, memory, EventBus    │
                         └────────┬──────────────┬──────────────────┘
                                  │              │
                    ┌─────────────▼──┐   ┌───────▼──────────────────┐
                    │   EventBus     │   │    RecoveryManager        │
                    │ Lifecycle      │   │  empty_response          │
                    │ Control Hooks  │   │  bash_failure             │
                    │ (src/events/)  │   │  context_exhaustion       │
                    └──────┬─────────┘   │  infinite_loop            │
                           │             └───────┬──────────────────┘
                           │                     │
         ┌─────────────────▼─────────────────────▼──────────────────┐
         │                  ActionExecutor (src/actions/)            │
         │  read ── edit ── write ── bash ── search_memory          │
         └────┬─────────────┬──────────────┬────────────────────────┘
              │             │              │
    ┌─────────▼──┐  ┌──────▼──────┐  ┌────▼──────────────────────┐
    │  Filesystem │  │  Terminal   │  │  HolographicMemory (FTS5) │
    │  (fs)       │  │  (shell)    │  │  (src/memory/)            │
    └─────────────┘  └─────────────┘  └───────────────────────────┘
```

## Module Responsibilities

### Session (`src/session/Session.ts`)

The central orchestrator. Owns the agent lifecycle: boot → trustGate → ready → running → shutdown. Wires together all subsystems — tools, memory, EventBus, compaction, handoff, recovery.

- Accepts a task, assembles the system prompt and conversation
- Runs the model turn loop: request → response → parse tool calls → execute → repeat
- Checks context budget before each turn; triggers `DeterministicCompactor`
- Delegates recovery to `RecoveryManager` on failure

### EventBus (`src/events/EventBus.ts`)

A typed pub/sub bus replacing raw EventEmitter. Two channel types:

- **Lifecycle events** (fire-and-forget): `session_start`, `turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`, `before_compact`, `session_compact`, `session_shutdown`, `child_session_spawned`, `child_session_completed`
- **Control hooks** (sequential, can intercept): `pre_tool_use`, `post_tool_use_failure`

Each control hook handler returns a `ControlDecision` — `{ allow: true }` to proceed, `{ allow: false, reason }` to block. The first blocking decision short-circuits the chain. This is the primary extension point for tool approval workflows and safety gates.

### ActionExecutor (`src/actions/ActionExecutor.ts`)

Dispatches tool calls to handlers. Current handlers:

| Handler         | Source                              | Purpose                                         |
| --------------- | ----------------------------------- | ----------------------------------------------- |
| `read`          | `handlers/read-handler.ts`          | Read files, list directories, search text       |
| `edit`          | `handlers/edit-handler.ts`          | Exact `replace_in_file` edits with safety gates |
| `write`         | `handlers/write-handler.ts`         | Create new text files                           |
| `bash`          | `handlers/bash-handler.ts`          | Execute shell commands (disabled by default)    |
| `search_memory` | `handlers/search-memory-handler.ts` | Query HolographicMemory via FTS5                |
| `view_image`    | `handlers/view-image-handler.ts`    | View image files                                |

Each handler validates input against policy, enforces path safety, and applies output caps.

### DeterministicCompactor (`src/compaction/DeterministicCompactor.ts`)

Tier 1 of the compaction pipeline. Zero-token structural compression that runs without an LLM call. Techniques applied in order:

1. **stripAnsiCodes** — remove terminal color escapes
2. **stripStackTraces** — collapse `node_modules/` lines in errors
3. **stripDuplicateLines** — collapse repeated stdout
4. **dedupRepeatedPatterns** — merge identical compiler/linter messages
5. **collapseWhitespace** — merge blank lines, trim indentation

Each technique is measured independently so token savings are reportable. Compaction triggers at ~60% of the effective context limit.

### HolographicMemory (`src/memory/HolographicMemory.ts`)

SQLite FTS5-backed semantic memory. Architectural differentiator from cloud agents:

- **Zero token overhead** — entries are stored in FTS5, not appended to context
- **Agent queries what it needs** — use `search_memory` to retrieve relevant history
- **Porter stemming** — "login form" matches "login forms"
- **Memory index** — a compact (~30-50 token) summary injected into every model request
- **Handoff manifests** — structured summaries for context-exhaustion handoffs

### HandoffManager (`src/handoff/HandoffManager.ts`)

Spawns child Sessions with fresh context when the parent's context window is exhausted. The child:

- Starts with a clean conversation (system prompt + handoff manifest)
- Inherits the parent's FTS5 memory database
- Uses `search_memory` to retrieve parent context on demand
- Capped at depth 3 to prevent infinite chains

### RecoveryManager (`src/recovery/RecoveryManager.ts`)

Pre-programmed recipes for failure scenarios. Each recipe injects a nudge message into the conversation and retries. Recipes are registered and can be customized:

| Scenario             | Behavior                                             |
| -------------------- | ---------------------------------------------------- |
| `empty_response`     | Inject "please continue" nudge, retry once           |
| `bash_failure`       | Feed stderr back to model, retry once                |
| `context_exhaustion` | Inject "stop reading, take action" nudge, retry once |
| `infinite_loop`      | Inject "try a different approach" steering message   |

### CostTracker & TokenCounter (`src/metrics/`)

Track token usage and cost in real time. Token counting uses approximate character-based estimation for local providers and API-reported counts for cloud providers. Cost tracking uses provider-specific pricing tables.

### SkillLoader (`src/skills/SkillLoader.ts`)

Auto-discovers SKILL.md files from:

- `~/.synax/skills/` — global skills (user-installed)
- `.synax/skills/` — project-specific skills

Skills are injected as additional system messages. Project skills override global skills by name.

### Tool-Call Parsers (`src/llm/parsers/`)

Native parsers for 26 model families. Extracts tool calls from raw model output regardless of format:

- **Qwen XML** — `<tool_call>...</tool_call>` tags
- **Hermes** — `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`
- **Llama 3 JSON** — `{"name": "...", "parameters": {...}}`
- **Mistral/DeepSeek** — function call tokens
- **Pythonic** — `function_name(arg=value)`
- **JSON-in-tags** — `[TOOL_CALLS] [...]`
- And many more

Repair logic handles malformed JSON (`json-repair.ts`), broken XML tags (`xml-repair.ts`), and leaked reasoning text (`reasoning-sanitizer.ts`).

## Data Flow

```
1. User submits task
   ↓
2. Session assembles conversation:
   - System prompt (capabilities, budget constraints)
   - Skill messages (from SKILL.md files)
   - Memory index (compact summary from HolographicMemory)
   - Tool definitions (model-facing tool surface)
   - User task
   ↓
3. Model request → LLM provider (Relay, Anthropic, DeepSeek, etc.)
   ↓
4. Response parsing:
   - Reasoning sanitization (strip thinking tags)
   - Tool-call extraction via native parser
   - Malformed output repair (JSON → XML repair)
   - Conversion to normalized Action shape
   ↓
5. EventBus emits pre_tool_use control hook
   - Extension handlers can allow, block, or modify the action
   ↓
6. ActionExecutor dispatches to handler
   - Handler validates input, enforces policy, applies caps
   ↓
7. EventBus emits tool_execution_end lifecycle event
   ↓
8. Tool result appended to conversation
   ↓
9. HolographicMemory stores entry (fire-and-forget)
   ↓
10. Context budget check
    - If over 60%: DeterministicCompactor runs
    - If still exhausted: HandoffManager spawns child session
    ↓
11. Repeat from step 3 until:
    - Model returns final answer → completed
    - Tool-call limit reached → budget_exhausted
    - Model-step limit reached → budget_exhausted
    - Error occurs → RecoveryManager attempts recovery
```

## Extension Points

Synax is designed for extensibility. The following extension points are public and documented:

1. **EventBus lifecycle subscribers** — react to any lifecycle event (`on()`, `onAny()`)
2. **EventBus control hooks** — intercept tool calls before execution (`onControl()`)
3. **Custom tools** — register new action handlers in `ActionExecutor`
4. **Custom tool-call parsers** — add parsers for new model families
5. **Custom repairers** — add repair logic for malformed structured output
6. **Custom recovery recipes** — register failure handling strategies
7. **Skills** — drop SKILL.md files into `.synax/skills/`

See [Extensions](/guide/extensions) for concrete code examples and `examples/hello-world-extension/` for a working example.

## Design Decisions

Key architectural choices informed by the SOTA review:

- **Local-first** — no cloud dependency for core agent loop
- **Deterministic compaction** — zero-token regex compression before LLM-based summarization
- **FTS5 memory** — semantic search without embedding models or vector databases
- **Typed EventBus** — type-safe pub/sub instead of raw EventEmitter
- **Recovery recipes** — pre-programmed failure paths rather than hoping the model recovers
- **Clean handoff** — child sessions with inherited memory rather than bloated context
- **Native parsers** — no vLLM normalization; parse raw model output directly
