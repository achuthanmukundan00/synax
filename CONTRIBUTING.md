# Contributing to Synax

Synax is a TypeScript-first, CLI-first, local-first coding agent for developers running local LLMs. Contributions that improve local-model reliability, documentation, tests, and extension points are welcome.

## Development Setup

```sh
git clone git@github.com:achuthanmukundan00/synax.git
cd synax
npm ci
npm run build
npm test
```

Requirements: Node.js 18+, npm, Git.

## Project Structure

```
src/
  agent/          Agent loop orchestration, safety, verification, rendering
  actions/        Action handlers (bash, read, write, edit, search-memory)
  cli.ts          CLI entry point
  commands/       CLI commands (chat, ask, run, inspect, config, doctor)
  compaction/     DeterministicCompactor — zero-token structural compression
  config/         Config loading, schema, profiles
  context/        Context strategy, local docs discovery
  env/            Execution environment abstraction
  events/         EventBus — typed pub/sub with lifecycle + control hooks
  extensions/     Extension interfaces + builtins
  handoff/        HandoffManager — context-exhaustion child session spawning
  llm/            LLM client, provider factory, tool-call parsers, repair
  logging/        Structured logging with redaction
  memory/         HolographicMemory — SQLite FTS5 semantic memory
  metrics/        TokenCounter, CostTracker, provider pricing
  orchestration/  Plan-based task orchestration
  recovery/       RecoveryManager — failure scenario recipes
  session/        Session — agent lifecycle orchestrator
  settings/       Runtime settings state, slash command registry
  skills/         SkillLoader — SKILL.md auto-discovery
  store/          EventStore (SQLite), schema, FTS5 migration
  telemetry/      SpanTracer for observability
  tools/          Tool registry, context ledger, policy
  tui/            Interactive terminal UI
  __tests__/      Jest test suites (mirrors src/ structure)

docs/             VitePress documentation site
specs/            Implementation specs and planning
examples/         Example extensions and configurations
```

### Key Modules

| Module                   | Responsibility                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `Session`                | Agent lifecycle: boot → trustGate → ready → running → shutdown                             |
| `EventBus`               | Typed pub/sub for lifecycle events and control hooks                                       |
| `ActionExecutor`         | Executes tool calls (bash, read, write, edit, search_memory)                               |
| `DeterministicCompactor` | Zero-token regex/structural compression (tier 1)                                           |
| `HolographicMemory`      | SQLite FTS5 semantic memory with 0-token overhead                                          |
| `HandoffManager`         | Context exhaustion → spawn child session with FTS5 inheritance                             |
| `RecoveryManager`        | Pre-programmed recipes for empty_response, bash_failure, context_exhaustion, infinite_loop |
| `SkillLoader`            | Auto-discovers SKILL.md files from ~/.synax/skills/ and .synax/skills/                     |

## How to Add a New Action Handler

1. Create a handler in `src/actions/handlers/` following the `ActionHandler` interface:
   ```ts
   export const myHandler: ActionHandler = {
     kind: 'my_action',
     execute: async (action, context) => {
       // implementation
       return { result: '...', exitCode: 0 };
     },
     describe: (action) => `my_action: ${action.field}`,
   };
   ```
2. Register it in `src/actions/ActionExecutor.ts` inside `createDefaultHandlerMap()`.
3. Add the action kind to `src/actions/types.ts`.
4. Add tests in `src/__tests__/tools.test.ts` or create a new test file.

## How to Add a New Tool-Call Parser

1. Create a parser module in `src/llm/parsers/`:
   ```ts
   export function parseMyModel(content: string): ToolCallParseResult | null {
     // extract tool calls from raw model output
   }
   ```
2. Register the parser in `src/llm/parsers/registry.ts` with a unique key.
3. Add tests in `src/__tests__/parsers/`.
4. Document the parser in `docs/guide/tool-call-parsing.md` if it supports a widely-used model family.

## How to Add a New Recovery Recipe

1. Define the failure scenario in `src/recovery/types.ts` in the `FailureScenario` union.
2. Add a recipe function in `src/recovery/RecoveryManager.ts`:
   ```ts
   async function myFailureRecipe(context: RecoveryContext): Promise<RecoveryResult> {
     // craft a nudge message, feed it to the conversation
     return { recovered: true, injectedMessage: nudge, conversation };
   }
   ```
3. Register the recipe in `RecoveryManager.registerDefaults()`.
4. Add tests in `src/__tests__/recovery-recipes.test.ts`.

## PR Checklist

Before opening a pull request:

- [ ] `npm run typecheck` passes (no new errors introduced)
- [ ] `npm run lint` passes, or use `npm run lint:fix`
- [ ] `npm run format` (Prettier) applied for TypeScript changes
- [ ] `npm test` passes — all 1079+ tests green
- [ ] `npm run build` succeeds
- [ ] `npm run docs:build` succeeds if docs were changed
- [ ] New behavior is covered by tests
- [ ] Public API changes are documented in `docs/`
- [ ] No unrelated cleanup or refactoring

### Style

- **TypeScript strict** — no implicit any, strict null checks
- **Prettier** — `npm run format` before committing TypeScript
- **ESLint** — `npm run lint`, configured for `.ts` files
- **Explicit return types** on exported functions
- **Discriminated unions** for structured states
- Keep files under ~500 LoC; add focused modules rather than extending large files

### Testing

- **Jest** with ts-jest
- Test files mirror the source tree: `src/foo/bar.ts` → `src/__tests__/bar.test.ts`
- Prefer targeted unit tests over broad integration tests
- For CLI changes, prefer smoke tests that exercise the actual CLI path
- For config changes, test: missing config, defaults, explicit config, invalid config
- For LLM/tool-call changes, test request shaping and parser behavior without requiring a live model

## Issue Labels

| Label             | Meaning                         |
| ----------------- | ------------------------------- |
| `type:feature`    | New product capability          |
| `type:bug`        | Defect or incorrect behavior    |
| `type:docs`       | Documentation-only              |
| `type:chore`      | Maintenance, tooling, CI        |
| `priority:p0`     | Blocks release or core workflow |
| `priority:p1`     | Important after p0 foundation   |
| `priority:p2`     | Nice to have                    |
| `area:docs`       | Documentation site or guides    |
| `area:cli`        | CLI commands and UX             |
| `area:llm`        | LLM client, parsers, providers  |
| `area:tools`      | Tool execution and registry     |
| `area:memory`     | HolographicMemory, handoff      |
| `area:extensions` | Extension system and interfaces |
| `milestone:M6`    | Community Readiness             |
| `milestone:M7`    | SDK Surface & Package           |

## Extension Points

Synax provides several extension points for community contributors:

- **EventBus subscribers** — hook into lifecycle events (`turn_start`, `tool_execution_end`, `session_compact`) and control hooks (`pre_tool_use`)
- **Custom tools** — register new tools via the extension system
- **Custom tool-call parsers** — add parsers for new model families
- **Custom repairers** — add repair logic for malformed structured output
- **Recovery recipes** — add failure recovery strategies
- **Skills** — drop SKILL.md files into `.synax/skills/` to inject behavior

See `docs/guide/extensions.md` and `examples/hello-world-extension/` for working examples.
