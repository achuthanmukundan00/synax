/**
 * Synax structured logging module.
 *
 * Replaces ad-hoc console.log with leveled, context-rich, secret-redacted logging.
 *
 * Usage:
 *   import { createLogger } from './logging';
 *   const logger = createLogger({ sessionId: 'abc123' });
 *   logger.info('Model call succeeded', { step: 3 });
 *   logger.error('Model call failed', err, { model: 'qwen' });
 */

export { Logger } from './Logger';
export type { LoggerOptions, LoggerEventStore, LogLevel, LogContext } from './Logger';
export { createLogger, resolveLogLevel, setGlobalLogLevel, isLogLevel, NOOP_EVENT_STORE } from './Logger';
export { redactSecrets, redactHeaders, redactValue } from './redact';
