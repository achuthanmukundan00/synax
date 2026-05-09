# Spec 001 — Extract Session class from runner.ts

**Issue:** #01  
**Milestone:** M1 — Architecture Foundation  
**Owner:** Achu  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p0 — blocks all other work

## Context

runner.ts is a 1,635-line God Object. It contains: turn loop, tool dispatch, context budget management, multi-stage compaction, bash safety, patch approval, read deduplication, token estimation, system prompt assembly, and orientation injection. This is the Synax equivalent of Codex's `turn.rs` (2,124 lines) and Pi's `agent-session.ts` (3,110 lines) — all three codebases have the same architectural sin.

From the SOTA review: "Every codebase has them (Codex's turn.rs, Synax's runner.ts, Pi's agent-session.ts, Claw-code's conversation.rs) — none are acceptable for v0.5."

Pi's architecture shows the right pattern: a pure `agent-loop.ts` (695 lines) that knows nothing about code, and a thin `agent-harness.ts` that bridges to application concerns. The Session class is the harness.

## Scope

**Creates:** `src/session/Session.ts` (~300 lines)  
**Modifies:** `src/agent/runner.ts` (delegates to Session)  
**Does NOT:** change tool execution, context budget logic, compaction, or CLI behavior

## Tasks

1. **Create `src/session/Session.ts`** with a `Session` class that owns:
   - `conversation: AgentConversation`
   - `registry: ToolRegistry`
   - `config: ResolvedConfig` (repo root, mode, budget settings)
   - `eventBus: EventBus` (initially a simple EventEmitter, swapped in #04)
   - `memory: HolographicMemory | null` (null until #12)

2. **Move `createAgentConversation` and `resetAgentConversation`** onto Session as static/instance methods

3. **Move `runAgentTurn` → `Session.startTurn(task: string): Promise<AgentTurnResult>`** — extract the outer function body into the class method, keeping all existing logic intact

4. **Move `buildModelFacingTools`** → `Session.buildModelTools()` (or keep static, but own the concept)

5. **Update `chat.ts`** to create a `Session` instead of calling `runAgentTurn` with a closure bag

6. **Update all callers** (run-task.ts, CLI handlers, tests) to use `Session` instead of `runAgentTurn`

7. **Ensure all 213 existing tests pass** with no behavioral changes

## Acceptance Criteria

- [ ] `src/session/Session.ts` exports a `Session` class with `startTurn(task)` method
- [ ] `chat.ts` creates `new Session(options)` instead of calling `runAgentTurn(options)`
- [ ] All existing tests pass unchanged (`npm test` = 213+ tests)
- [ ] `npm run typecheck && npm run build` pass
- [ ] CLI `synax run --task "..."` works identically to before
- [ ] `runner.ts` is reduced by at least 200 lines (delegation)
- [ ] Session owns lifecycle: construction → startTurn → shutdown
