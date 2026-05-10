/**
 * Handoff module — context handoff sub-agents with FTS5 inheritance.
 *
 * When context is exhausted, the parent agent checkpoints its state,
 * spawns a child session with fresh context + FTS5 inheritance, and
 * the child completes the task autonomously.
 */

export { HandoffManager } from './HandoffManager';
export type { HandoffManifest, HandoffReason, HandoffResult, HandoffManagerOptions } from './HandoffManager';
