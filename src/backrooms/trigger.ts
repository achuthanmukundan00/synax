/** Tiny trigger module kept separate from the Backrooms renderer/runtime. */

/** The secret trigger string. Case-sensitive, exact full-line match. */
export const SECRET_TRIGGER = ':synax/liminal/access/000';

/**
 * Test whether a trimmed user input exactly matches the secret trigger.
 * Leading/trailing whitespace has already been trimmed by the caller.
 */
export function isSecretTrigger(trimmed: string): boolean {
  return trimmed === SECRET_TRIGGER;
}
