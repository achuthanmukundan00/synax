/**
 * Structured Logger for Synax.
 *
 * Replaces ad-hoc console.log calls with leveled, context-rich logging
 * that redacts secrets and optionally writes to the EventStore.
 *
 * Levels (in order): trace < debug < info < warn < error
 *
 * Usage:
 *   const logger = new Logger({ level: 'info' });
 *   const child = logger.child({ sessionId: 'abc123' });
 *   child.info('Model call succeeded', { step: 3, model: 'qwen' });
 */

import { redactSecrets, redactValue } from './redact';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export interface LogContext {
  sessionId?: string;
  stepIndex?: number;
  toolName?: string;
  spanId?: string;
  model?: string;
  [key: string]: unknown;
}

/**
 * Minimal EventStore interface accepted by Logger.
 * The real EventStore (spec 005) implements this.
 */
export interface LoggerEventStore {
  appendLogEvent?: (entry: {
    level: LogLevel;
    message: string;
    timestamp: string;
    context?: Record<string, unknown>;
    error?: string;
  }) => void;
  /** Whether the store is available (connected, ready). */
  readonly available: boolean;
}

export interface LoggerOptions {
  level: LogLevel;
  sessionId?: string;
  eventStore?: LoggerEventStore;
}

export class Logger {
  private level: LogLevel;
  private sessionId?: string;
  private eventStore?: LoggerEventStore;
  private baseContext: LogContext;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.sessionId = options.sessionId;
    this.eventStore = options.eventStore;
    this.baseContext = options.sessionId ? { sessionId: options.sessionId } : {};
  }

  /** Check whether a given level should be emitted. */
  shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  /** Create a child logger that inherits level and merges context. */
  child(context: LogContext): Logger {
    const child = new Logger({
      level: this.level,
      sessionId: context.sessionId ?? this.sessionId,
      eventStore: this.eventStore,
    });
    child.baseContext = { ...this.baseContext, ...context };
    return child;
  }

  trace(msg: string, context?: LogContext): void {
    this.log('trace', msg, context);
  }

  debug(msg: string, context?: LogContext): void {
    this.log('debug', msg, context);
  }

  info(msg: string, context?: LogContext): void {
    this.log('info', msg, context);
  }

  warn(msg: string, context?: LogContext): void {
    this.log('warn', msg, context);
  }

  error(msg: string, error?: Error | null, context?: LogContext): void {
    this.log('error', msg, context, error ?? undefined);
  }

  private log(level: LogLevel, msg: string, context?: LogContext, error?: Error): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const mergedContext: Record<string, unknown> = {
      ...this.baseContext,
      ...context,
    };

    // Build structured entry
    const entry: Record<string, unknown> = {
      timestamp,
      level,
      msg,
    };

    if (Object.keys(mergedContext).length > 0) {
      entry.context = redactValue(mergedContext);
    }

    if (error) {
      entry.error = redactSecrets(error.message);
      if (error.stack) {
        entry.stack = redactSecrets(error.stack);
      }
    }

    // Redact the message itself
    const safeMsg = redactSecrets(msg);

    // Output to stdout/stderr (human-readable structured JSON)
    const line = formatLogLine(level, timestamp, safeMsg, entry);
    if (level === 'warn' || level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }

    // Write info+ to EventStore if available
    if (LEVEL_ORDER[level] >= LEVEL_ORDER['info']) {
      this.writeToEventStore(level, safeMsg, timestamp, mergedContext, error);
    }
  }

  private writeToEventStore(
    level: LogLevel,
    message: string,
    timestamp: string,
    context?: LogContext,
    error?: Error,
  ): void {
    if (!this.eventStore?.available) return;
    try {
      this.eventStore.appendLogEvent?.({
        level,
        message: redactSecrets(message),
        timestamp,
        context: context ? (redactValue(context) as Record<string, unknown>) : undefined,
        error: error ? redactSecrets(error.message) : undefined,
      });
    } catch {
      // Best-effort — Logger must not crash if EventStore is unavailable
    }
  }
}

/** Default no-op EventStore used when none is configured. */
export const NOOP_EVENT_STORE: LoggerEventStore = {
  available: false,
};

// ─── Global log level ───────────────────────────────────────

let globalLogLevel: LogLevel | null = null;

/**
 * Set the global log level.
 * Called by CLI after parsing --log-level and SYNAX_LOG_LEVEL.
 */
export function setGlobalLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

/**
 * Resolve the effective log level.
 * Priority: global (set by CLI) > SYNAX_LOG_LEVEL env var > default 'info'.
 */
export function resolveLogLevel(): LogLevel {
  if (globalLogLevel) return globalLogLevel;

  const envLevel = process.env.SYNAX_LOG_LEVEL?.toLowerCase();
  if (envLevel && isLogLevel(envLevel)) return envLevel;

  return 'info';
}

export function isLogLevel(value: string): value is LogLevel {
  return value === 'trace' || value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

/**
 * Create a root logger using the resolved global log level.
 */
export function createLogger(options?: { sessionId?: string; eventStore?: LoggerEventStore }): Logger {
  return new Logger({
    level: resolveLogLevel(),
    sessionId: options?.sessionId,
    eventStore: options?.eventStore,
  });
}

// ─── Formatting ─────────────────────────────────────────────

function formatLogLine(level: LogLevel, timestamp: string, msg: string, entry: Record<string, unknown>): string {
  // Compact human-readable format: timestamp LEVEL [context] message
  const sessionId = extractSessionId(entry);
  const contextTag = sessionId ? `[${sessionId.slice(0, 8)}] ` : '';
  return `${timestamp} ${level.toUpperCase().padEnd(5)} ${contextTag}${msg}`;
}

function extractSessionId(entry: Record<string, unknown>): string | undefined {
  const ctx = entry.context;
  if (ctx && typeof ctx === 'object' && ctx !== null) {
    const sid = (ctx as Record<string, unknown>).sessionId;
    if (typeof sid === 'string') return sid;
  }
  return undefined;
}
