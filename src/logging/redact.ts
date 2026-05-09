/**
 * Secret redaction for Synax structured logging.
 *
 * Redacts API keys, bearer tokens, passwords, and other secrets
 * from log output before writing to stdout or EventStore.
 */

const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+(?:=*)/gi;
const API_KEY_RE = /(?:_api[_-]?key|api[_-]?key|secret[_-]?key|token|auth)\s*[:=]\s*[^\s,;)}\]]+/gi;
const PASSWORD_RE = /(?:password|passwd|pwd)\s*[:=]\s*[^\s,;}]+/gi;
const KEY_VALUE_RE = /\b(?:sk|pk|AKIA)[A-Za-z0-9/+=]{20,}/g;
const X_API_KEY_RE = /X[-_]Api[-_]Key\s*:\s*[^\n]+/gi;
const AUTHORIZATION_RE = /Authorization\s*:\s*[^\n]+/gi;
const COOKIE_RE = /Cookie\s*:\s*[^\n]+/gi;

const REDACTED = '[REDACTED]';

/**
 * Redact secrets from a plain text string.
 * Handles API keys, bearer tokens, passwords, and common credential patterns.
 */
export function redactSecrets(text: string): string {
  let result = text;
  result = result.replace(BEARER_RE, `Bearer ${REDACTED}`);
  result = result.replace(API_KEY_RE, '$1: [REDACTED]');
  result = result.replace(PASSWORD_RE, '$1: [REDACTED]');
  result = result.replace(KEY_VALUE_RE, REDACTED);
  result = result.replace(X_API_KEY_RE, `X-Api-Key: ${REDACTED}`);
  result = result.replace(AUTHORIZATION_RE, `Authorization: ${REDACTED}`);
  result = result.replace(COOKIE_RE, `Cookie: ${REDACTED}`);
  return result;
}

/**
 * Redact sensitive values from a headers record.
 * Replaces Authorization, X-API-Key, and Cookie values with [REDACTED].
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const sensitive = new Set(['authorization', 'x-api-key', 'x-api-key-env', 'cookie', 'set-cookie']);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (sensitive.has(key.toLowerCase())) {
      result[key] = REDACTED;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Redact secrets from any value (string, object, array).
 * For objects, recursively redacts string values and known sensitive keys.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        redacted[key] = REDACTED;
      } else {
        redacted[key] = redactValue(val);
      }
    }
    return redacted;
  }
  return value;
}

const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'api-key',
  'secretkey',
  'secret_key',
  'password',
  'passwd',
  'authorization',
  'token',
  'bearer',
  'cookie',
  'set-cookie',
  'x-api-key',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}
