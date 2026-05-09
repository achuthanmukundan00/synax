# Spec 008 — Model-aware context strategy (synax doctor probes)

**Issue:** #08  
**Milestone:** M3 — Adaptive Context Survival  
**Owner:** Achu  
**Estimate:** 0.3d (AI-assisted)  
**Priority:** p0 — gates all compaction behavior

## Context

Synax currently hardcodes `contextWindowTokens: 131072` (128K) for all models. This is wrong. DeepSeek has 1M tokens. Qwen 2.5 has 32K-128K. Llama 3 has 8K-128K. A one-size-fits-all budget either wastes context on big models or starves small models.

From the SOTA review core thesis: "The higher the context window of the model natively is, the less we do with context management." This is the adaptive context strategy — calibrate all context behavior to the model's actual window.

The strategy table:
| Model Window | Strategy | Compaction | Reserve |
|---|---|---|---|
| ≤32K | aggressive | deterministic + summarization + handoff | 8K |
| 32K–128K | moderate | deterministic only | 16K |
| 128K–1M | light | dedup + strip noise | 32K |
| 1M+ | none | no compaction | 64K |

Implementation: `synax doctor` already probes the provider. Extend it to probe the model's context window via the API's `/models` endpoint or a test request. Then auto-configure `ContextStrategy` on Session construction.

## Scope

**Creates:** `src/context/ContextStrategy.ts`  
**Modifies:** `src/llm/provider-presets.ts`, `src/agent/context-budget.ts`, `src/session/Session.ts`, `src/commands/doctor.ts`  
**Does NOT:** implement compaction changes, add new compaction algorithms

## Tasks

1. **Create `ContextStrategy` type in `src/context/ContextStrategy.ts`:**
   ```typescript
   type ContextStrategy =
     | { mode: 'aggressive'; compact: 'deterministic+summarization+handoff'; reserveTokens: 8192 }
     | { mode: 'moderate'; compact: 'deterministic'; reserveTokens: 16384 }
     | { mode: 'light'; compact: 'dedup+strip'; reserveTokens: 32768 }
     | { mode: 'none'; compact: false; reserveTokens: 65536 }
     | { mode: 'off'; compact: false; reserveTokens: 0 };
   ```

2. **Add `resolveStrategy(contextWindow: number): ContextStrategy`** function

3. **Extend provider presets** — add `contextWindow` field to each preset:
   - OpenAI: 128K (GPT-4o), 200K (Claude via proxy)
   - DeepSeek: 1M (deepseek-chat)
   - Qwen: 32K (GGUF default), 128K (API)
   - Llama: 8K (GGUF default), 128K (API)

4. **Update `synax doctor`** — add `contextWindow` to output, show resolved strategy

5. **Wire into Session** — `Session` calls `resolveStrategy(config.model.contextWindow)` and uses it to configure `ContextBudgetSettings`

6. **Add a `--strategy` flag to `synax run`** — allow manual override: `synax run --strategy aggressive`

## Acceptance Criteria

- [ ] `synax doctor` reports model's context window and resolved strategy
- [ ] Session auto-configures budget based on model, not hardcoded 128K
- [ ] DeepSeek (1M) gets `mode: 'none'` → no compaction overhead
- [ ] Qwen GGUF (32K) gets `mode: 'aggressive'` → full compaction pipeline
- [ ] `--strategy` flag overrides auto-detection
- [ ] Unknown models default to `moderate` (safe default)
- [ ] Existing tests pass (update any tests that assume 128K)
