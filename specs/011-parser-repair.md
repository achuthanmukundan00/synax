# Spec 011 — Parser repair implementation: JSON/XML auto-recovery

**Issue:** #11  
**Milestone:** M3 — Adaptive Context Survival  
**Owner:** Achu  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p1 — local models produce malformed tool calls frequently

## Context

Synax has 12 tool-call parsers for local models (llama3-json, qwen3-xml, hermes, deepseek, mistral, etc.) but repair is stubbed:
```typescript
toolCallRepairer: { repairMalformedJson: () => null }
reasoningSanitizer: { sanitize: (content) => ({ content, removedReasoning: false }) }
```

From the SOTA review: "Terminus does dual-format parsing (JSON + XML) with auto-recovery. Synax detects format but doesn't repair." This is the missing piece that makes local models reliable.

Local models frequently produce:
- Trailing commas: `{"name": "read", "args": {"path": "x",}}`
- Unescaped quotes: `{"query": "find "foo" in bar"}`
- Truncated objects: `{"name": "bash", "args": {"command": "npm te`
- Missing closing braces: `{"name": "edit", "args": {"path": "x", "oldStr": "y"`
- Leaked reasoning tags: `<thinking>I should read the file</thinking>{"name": "read"...}`
- Mixed format: model emits both `<tool_call>` XML AND `message.tool_calls`

This issue implements repair for JSON format (most common failure) and XML format (Qwen's native format). The existing 12-parser registry gets repair functions instead of stubs.

## Scope

**Creates:** `src/llm/repair/json-repair.ts`, `src/llm/repair/xml-repair.ts`, `src/llm/repair/reasoning-sanitizer.ts`  
**Modifies:** `src/llm/parsers/` (add repair to each parser), `src/extensions/builtins.ts` (wire real repairers)  
**Does NOT:** add new parsers, change the parser registry architecture

## Tasks

1. **Create `src/llm/repair/json-repair.ts`:**
   - `repairJson(raw: string): { repaired: string; fixes: string[] } | null`
   - Fixes: trailing commas, unescaped inner quotes (heuristic), missing closing braces/brackets (balance check), truncated objects (add synthetic close)
   - Returns `null` if unrepairable (garbage input)
   - `fixes[]` lists what was changed for debugging

2. **Create `src/llm/repair/xml-repair.ts`:**
   - `repairXml(raw: string): { repaired: string; fixes: string[] } | null`
   - Fixes: unclosed `<tool_call>` tags, leaked `<thinking>` tags inside tool calls, mixed XML+text content
   - Returns `null` if unrepairable

3. **Create `src/llm/repair/reasoning-sanitizer.ts`:**
   - `sanitizeReasoning(content: string): { sanitized: string; removedReasoning: boolean }`
   - Remove `<think>...</think>`, `<thinking>...</thinking>`, `<｜end▁of▁thinking｜>...` blocks
   - Handle DeepSeek-style `reasoring_content` leakage into `content`

4. **Wire into `builtins.ts`** — replace stubs with real implementations:
   ```typescript
   toolCallRepairer: { repairMalformedJson: repairJson },
   reasoningSanitizer: { sanitize: sanitizeReasoning },
   ```

5. **Add repair tests** — for each fix type, a test confirming repair succeeds and parses correctly

6. **Add fallback path** — if repair fails, inject raw output as user message: "Your last response was malformed. Please retry with proper JSON tool calls."

## Acceptance Criteria

- [ ] `repairJson` fixes: trailing commas, unescaped quotes, missing braces, truncated objects
- [ ] `repairXml` fixes: unclosed tags, leaked reasoning tags
- [ ] `sanitizeReasoning` strips `<think>`, `<thinking>`, ` response` blocks
- [ ] At least 5 test cases per repair function confirming repair+parse works
- [ ] Unrepairable input returns `null` (not broken JSON)
- [ ] Fallback path injects retry nudge when repair fails
- [ ] Existing 213+ tests pass
- [ ] `builtins.ts` no longer has `() => null` stubs
