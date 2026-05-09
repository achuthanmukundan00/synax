# Spec 010 — Recovery recipes: 7 failure scenarios, never fail-closed

**Issue:** #10  
**Milestone:** M3 — Adaptive Context Survival  
**Owner:** Achu  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p0 — survival is the meta-goal

## Context

Synax currently has 7 terminal states: `completed`, `blocked`, `failed_verification`, `budget_exhausted`, `user_input_required`, `model_error`, `tool_error`. Most of these are fail-closed — the agent stops and returns an error. This violates the core survival thesis.

From the SOTA review: "Survival = success (Terminus insight). The agent that survives the longest wins. Every failure mode (malformed JSON, context exhaustion, model error, tool failure) should be a recovery path, not a terminal state."

From Claw Code: "Recovery recipes (7 failure scenarios) — known failures have pre-programmed recovery paths." The insight is that each failure mode has a known recovery action. The agent should try recovery automatically before giving up.

Synax's equivalent failure modes and their recovery recipes:
1. **Missing API key** → prompt user, don't crash
2. **Empty model response** → retry with nudge: "Your response was empty. Please continue."
3. **Malformed tool call** → parser repair (#11), then retry
4. **Provider error (401/429/500)** → exponential backoff, switch provider if configured
5. **Bash failure** → feed stderr to model as context
6. **Context exhaustion** → trigger compaction, then handoff (#14), never `budget_exhausted`
7. **Infinite loop detection** → inject steering message: "You appear stuck. Try a different approach."

## Scope

**Creates:** `src/recovery/RecoveryRecipes.ts`, `src/recovery/types.ts`  
**Modifies:** `src/session/Session.ts` (wrap turn loop in recovery), `src/agent/runner.ts` (replace terminalState returns with recovery attempts)  
**Does NOT:** implement parser repair (#11), handoff (#14), or provider switching

## Tasks

1. **Create `src/recovery/types.ts`:**
   ```typescript
   type FailureScenario =
     | 'missing_api_key'
     | 'empty_response'
     | 'malformed_tool_call'
     | 'provider_error'
     | 'bash_failure'
     | 'context_exhaustion'
     | 'infinite_loop';
   
   interface RecoveryAction {
     scenario: FailureScenario;
     maxAttempts: number;
     action: (context: RecoveryContext) => Promise<RecoveryResult>;
   }
   ```

2. **Create `src/recovery/RecoveryRecipes.ts`** — for each scenario:
   - `missingApiKey`: throw clear error pointing to `synax config set provider.apiKey`
   - `emptyResponse`: inject user message "Your last response was empty. Continue from where you left off."
   - `malformedToolCall`: call parser repair (#11 placeholder), if repaired, retry; if not, inject "Format your tool calls as proper JSON."
   - `providerError`: if 429, wait `Retry-After` seconds and retry; if 401, prompt for key; if 500, retry once then switch provider
   - `bashFailure`: inject stderr as user message: "Command failed: <stderr>. Fix and retry."
   - `contextExhaustion`: trigger deterministic compaction (#09), if still over, trigger handoff (#14 placeholder)
   - `infiniteLoop`: if same tool+args called >5x without progress, inject "You are repeating the same action. Try a fundamentally different approach or ask for guidance."

3. **Wrap Session.startTurn()** in recovery loop:
   ```typescript
   for (let recoveryAttempt = 0; recoveryAttempt < maxRecoveryAttempts; recoveryAttempt++) {
     try {
       return await this.runTurnLoop(task);
     } catch (failure) {
       const recipe = this.recovery.getRecipe(failure.scenario);
       if (!recipe || recoveryAttempt >= recipe.maxAttempts) throw failure;
       await recipe.action(recoveryContext);
     }
   }
   ```

4. **Replace terminal `return` statements** in runner.ts with `throw new RecoverableError(scenario, details)`

## Acceptance Criteria

- [ ] All 7 failure scenarios have recovery recipes
- [ ] Empty model response triggers retry (not `model_error`)
- [ ] 429 rate limit triggers wait-and-retry (not immediate failure)
- [ ] Bash failure feeds stderr back to model (not `tool_error`)
- [ ] Context exhaustion triggers compaction before failing
- [ ] Infinite loop detection injects steering message
- [ ] Each scenario tested with a mock
- [ ] Recovery events emitted to EventBus for observability
- [ ] Existing tests pass (update tests that expect immediate failure)
