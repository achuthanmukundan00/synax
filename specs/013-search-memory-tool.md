# Spec 013 — search_memory tool for the agent

**Issue:** #13  
**Milestone:** M4 — Holographic Memory  
**Owner:** Achu  
**Estimate:** 0.3d (AI-assisted)  
**Priority:** p1 — makes memory agent-accessible

## Context

The holographic memory (#12) stores everything but the agent can't access it yet. This issue adds a `search_memory` tool that the model can call during a turn to retrieve historical context from FTS5.

From the synthesis: "The agent has a search_memory(query) tool that queries FTS5. The handoff includes suggested search terms, so the agent knows what to look for."

Unlike `read` which inspects the filesystem, `search_memory` inspects the conversation history. This is the agent's "what did I do 5 turns ago?" capability. For tasks that span many turns (or handoff chains), this replaces the model trying to remember from degraded context.

The tool is particularly powerful for:
- "What was the exact error from the test run 3 turns ago?"
- "Which files did I modify when fixing the login bug?"
- "What was the original user request?"
- Retrieving exact file contents the agent read earlier but that have been truncated from context

## Scope

**Creates:** `src/actions/handlers/search-memory-handler.ts`  
**Modifies:** `src/actions/ActionExecutor.ts` (register new handler), `src/agent/runner.ts` (add to tool surface), `src/memory/HolographicMemory.ts` (expose search with formatted output)  
**Does NOT:** add semantic search beyond FTS5, implement embeddings, add external search APIs

## Tasks

1. **Create `src/actions/handlers/search-memory-handler.ts`:**
   ```typescript
   async function handleSearchMemory(
     input: { query: string; maxResults?: number; filterTool?: string; filterTurnRange?: [number, number] },
     context: { memory: HolographicMemory }
   ): Promise<ToolResult> {
     const results = context.memory.search(input.query, input.maxResults ?? 10);
     // Format results with turn_id, role, tool_name, file_paths, and content preview
     return { success: true, output: { results, count: results.length } };
   }
   ```

2. **Register in ActionExecutor** — add to the handler map, add to `AgentAction` union type:
   ```typescript
   | { kind: 'search_memory'; query: string; maxResults?: number }
   ```

3. **Add to model-facing tools** — `buildModelFacingTools()` includes `search_memory`:
   - Description: "Search conversation history for past actions, errors, and file changes."
   - Schema: `{ query: string, maxResults?: number }`
   - Safety: `readOnly: true`, no path access

4. **Add orientation hint** — when memory is available, inject into system prompt: "Use search_memory to recall past context instead of re-reading files."

5. **Format results for model consumption** — each result shows: `[Turn #3] tool:read → file:src/login.ts — content preview...`

## Acceptance Criteria

- [ ] Agent can call `search_memory("login bug")` and get relevant history
- [ ] FTS5 ranking: more relevant entries appear first
- [ ] Results include turn number, role, tool name, file paths, content preview
- [ ] `maxResults` limits output
- [ ] Works across handoff boundaries (searches parent session's memory too)
- [ ] Tool is `readOnly: true` (no mutations)
- [ ] Agent works when memory is unavailable (tool returns empty results, not error)
- [ ] Existing tests pass, new test verifies search_memory handler
