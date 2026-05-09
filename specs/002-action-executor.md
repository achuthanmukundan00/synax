# Spec 002 — Extract typed ActionExecutor from runner.ts

**Issue:** #02  
**Milestone:** M1 — Architecture Foundation  
**Owner:** Achu  
**Estimate:** 0.3d (AI-assisted)  
**Priority:** p0 — blocks typed actions in M3

## Context

Currently `executeAgentTool` in runner.ts is a switch statement dispatching to `executeReadTool`, `executeReplaceInFile`, `executeCreateFile`, `executeBashTool`. Each tool handler is a standalone function with its own safety checks, path resolution, and error handling. This is fragile and makes adding new tools invasive.

From the SOTA review on Warp: "Typed actions (25+ with semantic fields) — `is_read_only`, `is_risky`, `uses_pager` enable precise gating." Codex uses a `ToolHandler` trait + `ToolRouter`. Synax needs an `ActionExecutor` that dispatches typed actions through a registry.

The key insight: the executor should NOT know about individual tool implementations. It should dispatch by action type, enforce safety policy, and emit events. Tool implementations become standalone handlers registered at construction time.

## Scope

**Creates:** `src/actions/ActionExecutor.ts`, `src/actions/types.ts`  
**Modifies:** `src/agent/runner.ts` (delegates tool dispatch to ActionExecutor)  
**Does NOT:** change tool implementations, add new tools, or change safety policies

## Tasks

1. **Create `src/actions/types.ts`** — define `AgentAction` discriminated union:
   ```typescript
   type AgentAction =
     | { kind: 'read'; path?: string; startLine?: number; endLine?: number; query?: string }
     | { kind: 'edit'; path: string; oldStr: string; newStr: string }
     | { kind: 'write'; path: string; content: string }
     | { kind: 'bash'; command: string }
   ```
   With metadata: `isReadOnly`, `targetsPaths`, `isRisky`

2. **Create `src/actions/ActionExecutor.ts`** — a class that:
   - Takes a `Map<ActionKind, ActionHandler>` at construction
   - `execute(action: AgentAction, context: ExecutionContext): Promise<ActionResult>`
   - Enforces `canMutatePath` for write actions
   - Emits `tool_started` / `tool_finished` events (via callback, EventBus in #04)
   - Handles read cache, repetition detection, bash dedup

3. **Extract individual tool handlers** from runner.ts into `src/actions/handlers/`:
   - `read-handler.ts` (from `executeReadTool`)
   - `edit-handler.ts` (from `executeReplaceInFile`)
   - `write-handler.ts` (from `executeCreateFile`)
   - `bash-handler.ts` (from `executeBashTool`)

4. **Wire ActionExecutor into Session** — Session constructs the executor with handlers

5. **Update runner.ts** — `executeAgentTool` becomes a thin delegation to `this.executor.execute(action, context)`

## Acceptance Criteria

- [ ] `src/actions/ActionExecutor.ts` dispatches all 4 tool types correctly
- [ ] Each handler is in its own file under `src/actions/handlers/`
- [ ] Read cache, repetition detection, bash dedup still work
- [ ] All 213+ existing tests pass unchanged
- [ ] `npm run typecheck && npm run build` pass
- [ ] runner.ts loses the 4 `execute*Tool` functions (moved, not deleted)
