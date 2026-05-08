/**
 * Synax Backrooms — hidden terminal exploration mode.
 *
 * Public API: runSynaxBackrooms() and secret trigger detection.
 *
 * ## Attribution
 * Rendering approach conceptually inspired by:
 *   Lallapallooza/c_ascii_render (Apache-2.0 License)
 *   https://github.com/Lallapallooza/c_ascii_render
 * No code was copied — this is an independent TypeScript implementation.
 */
export { SECRET_TRIGGER, isSecretTrigger } from './trigger';
export { runSynaxBackrooms } from './runBackrooms';
export type { BackroomsOptions } from './types';
