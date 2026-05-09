# Spec 018 — Typed verification contracts (replace regex completion detection)

**Issue:** #18  
**Milestone:** M6 — Community Readiness  
**Owner:** Achu  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p1 — replaces fragile regex with typed quality gates

## Context

Synax currently detects premature completion with regex:
```typescript
const prematurePhrases = [
  'verified passed', 'verification passed', 'all tests pass',
  'completed successfully', 'task complete', 'work is complete',
];
```

This is fragile, language-specific, and easily fooled. A model saying "I ran `verified passed` as the test command" would trigger a false positive.

From the SOTA review on Claw Code: "Green contracts (GreenLevel: TargetedTests→Package→Workspace→MergeReady) — typed quality gates, not regex completion checks." And from Codex: "GoalRuntimeState with token budgets — prevents infinite loops. The agent doesn't 'declare' completion — the system detects when goals are met."

The replacement: typed verification contracts. The user specifies what "done" means:
```typescript
type VerificationContract =
  | { level: 'none' }                              // accept any completion
  | { level: 'files_changed'; minFiles: number }    // at least N files modified
  | { level: 'verification_ran'; command: string }  // a verification command was executed
  | { level: 'verification_passed'; command: string; expectedExitCode: number } // verification passed
  | { level: 'tests_passing'; testCommand: string }  // all tests pass
```

The system checks the contract. The model doesn't self-declare completion.

## Scope

**Creates:** `src/verification/VerificationContract.ts`, `src/verification/ContractChecker.ts`  
**Modifies:** `src/agent/runner.ts` (replace `isPrematureCompletionClaim`), `src/agent/verification.ts`  
**Does NOT:** implement Codex-style goal tracking (deferred), add automated test runners

## Tasks

1. **Create `src/verification/VerificationContract.ts`:**
   ```typescript
   type VerificationLevel = 'none' | 'files_changed' | 'verification_ran' | 'verification_passed' | 'tests_passing';
   
   interface VerificationContract {
     level: VerificationLevel;
     // For files_changed:
     minFiles?: number;
     // For verification_ran / verification_passed / tests_passing:
     command?: string;
     expectedExitCode?: number;
     // Common:
     description?: string;
   }
   ```

2. **Create `src/verification/ContractChecker.ts`:**
   ```typescript
   function checkContract(
     contract: VerificationContract,
     evidence: { changedFiles: string[]; bashCommands: string[]; exitCodes: number[] }
   ): { satisfied: boolean; missingEvidence: string[] };
   ```

3. **Replace `isPrematureCompletionClaim`:**
   - When model says "task complete" → check contract
   - If contract unsatisfied → inject specific guidance: "Verification contract requires tests passing. Run `npm test` first."
   - If contract satisfied → accept completion

4. **Add `--verify` flag to `synax run`:**
   - `synax run --verify none` (default, backward compatible)
   - `synax run --verify files-changed`
   - `synax run --verify tests-passing --test-command "npm test"`

5. **Update system prompt** to communicate the verification contract to the model

## Acceptance Criteria

- [ ] `--verify tests-passing` blocks completion until tests pass
- [ ] `--verify files-changed` blocks completion until at least 1 file modified
- [ ] `--verify none` accepts any completion (backward compatible)
- [ ] Contract check output is specific: "Missing: verification command 'npm test' not yet executed with exit code 0"
- [ ] `isPrematureCompletionClaim` function is replaced by `checkContract`
- [ ] False positives from regex detection are gone
- [ ] Existing tests pass (default = `none` contract)
- [ ] New tests cover each verification level
