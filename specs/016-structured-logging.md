# Spec 016 — Structured logging with levels, context, and redaction

**Issue:** #16  
**Milestone:** M5 — Production Hardening  
**Owner:** Harry  
**Estimate:** 0.5d (AI-assisted)  
**Priority:** p1 — replaces ad-hoc console.log with debuggable logging

## Context

Synax currently uses `console.log` and `console.error` scattered throughout the codebase. There's no log levels, no structured context, no redaction of sensitive data (API keys, bearer tokens), and no way to control verbosity. Debugging agent failures requires reading raw stdout.

Harry's domain expertise: "metrics, logging, observability, telemetry." This issue creates a structured logging system that:
- Supports levels: `trace`, `debug`, `info`, `warn`, `error`
- Includes context: session ID, turn number, tool name, span ID
- Redacts secrets: API keys, bearer tokens, passwords in command output
- Outputs to: stdout (human-readable), EventStore (structured, queryable)
- Is controllable via `--log-level` flag and `SYNAX_LOG_LEVEL` env var

## Scope

**Creates:** `src/logging/Logger.ts`, `src/logging/redact.ts`  
**Modifies:** Replace scattered `console.log` calls throughout `src/` with Logger usage  
**Does NOT:** add log aggregation services, file-based log output, or log rotation

## Tasks

1. **Create `src/logging/Logger.ts`:**
   ```typescript
   class Logger {
     constructor(options: { level: LogLevel; sessionId?: string });
     
     trace(msg: string, context?: LogContext): void;
     debug(msg: string, context?: LogContext): void;
     info(msg: string, context?: LogContext): void;
     warn(msg: string, context?: LogContext): void;
     error(msg: string, error?: Error, context?: LogContext): void;
     
     child(context: LogContext): Logger; // scoped logger with defaults
   }
   ```

2. **Create `src/logging/redact.ts`:**
   - `redactSecrets(text: string): string` — replaces API keys, tokens, passwords with `[REDACTED]`
   - `redactHeaders(headers: Record<string, string>): Record<string, string>` — redacts Authorization, X-API-Key, Cookie

3. **Add CLI flag:** `--log-level` (choices: trace, debug, info, warn, error; default: info)
   - Also respects `SYNAX_LOG_LEVEL` env var (flag takes precedence)

4. **Wire Logger into Session** — Session creates a child logger with `{ sessionId }`, passes to EventBus, ActionExecutor, handlers

5. **Replace key `console.log` calls:**
   - Model call errors → `logger.error("Model call failed", error, { step, model })`
   - Tool execution → `logger.debug("Executing tool", { toolName, args })`
   - Compaction → `logger.info("Compacting", { stage, tokensBefore, tokensAfter })`
   - Budget warnings → `logger.warn("Context budget near limit", { used, limit })`

6. **Log to EventStore** — `info` and above are written to EventStore as structured events

## Acceptance Criteria

- [ ] `--log-level trace` shows all debug output; `--log-level error` shows only errors
- [ ] API keys, bearer tokens, and passwords are redacted in log output
- [ ] Each log line includes session ID (when in session context)
- [ ] `info`+ logs appear in EventStore for post-hoc analysis
- [ ] No raw `console.log` calls remain in `src/session/`, `src/actions/`, `src/agent/`
- [ ] Logger does not crash if EventStore is unavailable
- [ ] Existing tests pass (tests can set log level to `error` for quiet output)
