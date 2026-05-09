# Spec 017 — Token usage metrics and cost tracking

**Issue:** #17  
**Milestone:** M5 — Production Hardening  
**Owner:** Harry  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p1 — users need to know what their agent costs

## Context

Synax has no token counting or cost tracking. Users running local models don't pay per-token, but when using API providers (OpenAI, Anthropic, DeepSeek), cost matters. Even for local models, knowing token consumption helps tune context strategy and detect runaway loops.

From the SOTA review on Codex: "GoalRuntimeState with token budgets — prevents infinite loops." Token budgets should be visible and trackable.

This issue adds:
- Per-turn token counting (input tokens, output tokens)
- Per-session cost estimation (based on provider pricing)
- Cumulative metrics in `synax inspect --metrics`
- Budget warnings when approaching limits

## Scope

**Creates:** `src/metrics/TokenCounter.ts`, `src/metrics/CostTracker.ts`, `src/metrics/provider-pricing.ts`  
**Modifies:** `src/session/Session.ts` (count tokens per turn), `src/store/EventStore.ts` (store token data)  
**Does NOT:** add accurate tokenizers (tiktoken) — uses character-based estimation initially

## Tasks

1. **Create `src/metrics/provider-pricing.ts`:**
   ```typescript
   const PROVIDER_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
     'openai/gpt-4o': { inputPer1M: 2.50, outputPer1M: 10.00 },
     'openai/gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
     'anthropic/claude-sonnet': { inputPer1M: 3.00, outputPer1M: 15.00 },
     'deepseek/deepseek-chat': { inputPer1M: 0.14, outputPer1M: 0.28 },
     // Local models: free
   };
   ```

2. **Create `src/metrics/TokenCounter.ts`:**
   - `countInput(messages: AgentMessage[]): number` — reuse existing `estimateRequestTokens`
   - `countOutput(response: ChatResponse): number` — count response content + tool call tokens
   - `getTurnStats(): TurnTokenStats` — { inputTokens, outputTokens, totalTokens }

3. **Create `src/metrics/CostTracker.ts`:**
   - `estimateCost(model: string, inputTokens: number, outputTokens: number): number`
   - `getSessionCost(sessionId: string): number` — sum of all turn costs
   - `getCumulativeCost(): number` — all-time cost across all sessions

4. **Wire into Session:**
   - After each model call: count input/output tokens, estimate cost
   - Store in EventStore with each turn event
   - Emit `token_usage` event: { inputTokens, outputTokens, estimatedCost }

5. **Add to `synax inspect --metrics`:**
   - Show cost per session
   - Show cumulative all-time cost
   - Show token efficiency (tokens per file changed, tokens per successful task)

6. **Add `--budget` flag to `synax run`** — set a max cost budget, agent stops when exceeded

## Acceptance Criteria

- [ ] Token counts logged per turn in EventStore
- [ ] Cost estimated per session based on provider pricing
- [ ] `synax inspect --metrics` shows: tokens per session, cost per session, cumulative cost
- [ ] `--budget $0.50` stops agent after $0.50 of API usage
- [ ] Local models show `$0.00` cost
- [ ] Token counting uses existing `estimateTokens` (no new dependency)
- [ ] Existing tests pass
