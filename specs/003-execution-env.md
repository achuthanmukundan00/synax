# Spec 003 — Add ExecutionEnv abstraction

**Issue:** #03  
**Milestone:** M1 — Architecture Foundation  
**Owner:** Achu  
**Estimate:** 0.2d (AI-assisted)  
**Priority:** p1 — unblocks sandboxing in M5

## Context

Currently runner.ts calls `fs` and `child_process` directly: `existsSync`, `mkdir`, `readFile`, `atomicWriteFile`, `execFile`. Pi uses an `ExecutionEnv` interface that abstracts filesystem and process operations behind a trait. This is critical for:
- Testing (mock filesystem without temp dirs)
- Sandboxing (swap real fs for sandboxed fs)
- Future browser/WebContainer runtime

From the Pi deconstruction: "The agent harness uses an ExecutionEnv abstraction. File operations and shell execution go through an interface, not fs and child_process directly. This means the agent can run in a sandboxed environment, a browser, or a test harness."

This is a 0.2d task because it's purely mechanical: define the interface, create a `NodeExecutionEnv` that wraps the existing calls, and thread it through.

## Scope

**Creates:** `src/env/ExecutionEnv.ts`, `src/env/NodeExecutionEnv.ts`  
**Modifies:** `src/agent/runner.ts`, `src/agent/safety.ts`, `src/tools/`  
**Does NOT:** implement sandboxing, change behavior, or add browser support

## Tasks

1. **Define `ExecutionEnv` interface:**
   ```typescript
   interface ExecutionEnv {
     fileExists(path: string): boolean;
     readFile(path: string): Promise<string>;
     writeFile(path: string, content: string): Promise<void>;
     makeDir(path: string): Promise<void>;
     execCommand(command: string, cwd: string, opts?: ExecOptions): Promise<ExecResult>;
   }
   ```

2. **Create `NodeExecutionEnv`** — wraps `fs.promises` and `child_process.execFile`

3. **Thread `env: ExecutionEnv` through:**
   - `Session` constructor (defaults to `NodeExecutionEnv`)
   - `ActionExecutor` (for file reads/writes)
   - Bash handler (for command execution)
   - `safety.ts` (for `existsSync` → `env.fileExists`)

4. **Update existing call sites** — all direct `fs`/`child_process` calls in runner.ts go through `env`

5. **Add a test** that uses a mock `ExecutionEnv` to verify the abstraction works

## Acceptance Criteria

- [ ] `ExecutionEnv` interface defined in `src/env/ExecutionEnv.ts`
- [ ] `NodeExecutionEnv` wraps all current fs/process calls
- [ ] Session, ActionExecutor, and handlers all use `this.env` instead of direct imports
- [ ] Existing tests pass (NodeExecutionEnv is the default)
- [ ] At least one test uses a mock ExecutionEnv
- [ ] No `import { readFile } from 'fs/promises'` in runner.ts or handlers
