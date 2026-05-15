/**
 * ActionExecutor — typed tool dispatch extracted from Session.ts.
 *
 * Replaces the switch-statement dispatch in executeAgentTool with a
 * handler map that dispatches by AgentAction.kind. Each handler is a
 * standalone function registered at construction time.
 */

import type { ParsedToolCall } from '../llm/tool-calls';
import type { ToolRegistry } from '../tools/types';

import {
  type AgentAction,
  type AgentToolExecutionResult,
  type ActionHandler,
  type ExecutionContext,
  toolFailure,
  toAgentAction,
} from './types';
import { handleRead } from './handlers/read-handler';
import { handleEdit } from './handlers/edit-handler';
import { handleWrite } from './handlers/write-handler';
import { handleBash } from './handlers/bash-handler';
import { handleSearchMemory } from './handlers/search-memory-handler';
import { handleViewImage } from './handlers/view-image-handler';

// ─── Handler map type ─────────────────────────────────────

export type ActionKind = AgentAction['kind'];

export type HandlerMap = Map<ActionKind, ActionHandler>;

// ─── Default handler map factory ──────────────────────────

/**
 * Create the default handler map with all built-in tool handlers.
 * Synchronous so Session can construct it inline.
 */
export function createDefaultHandlerMap(): HandlerMap {
  const map: HandlerMap = new Map();
  map.set('read', handleRead as ActionHandler);
  map.set('edit', handleEdit as ActionHandler);
  map.set('write', handleWrite as ActionHandler);
  map.set('bash', handleBash as ActionHandler);
  map.set('search_memory', handleSearchMemory as ActionHandler);
  map.set('view_image', handleViewImage as ActionHandler);
  return map;
}

// ─── ActionExecutor class ─────────────────────────────────

/**
 * Typed tool dispatcher. Wraps a handler map and provides execute() for
 * turn-loop integration. Handles argument coercion, bash repetition detection,
 * and fallback to the ToolRegistry for custom tools.
 */
/**
 * @public
 */
export class ActionExecutor {
  private handlers: HandlerMap;
  private registry: ToolRegistry;

  constructor(options: { handlers: HandlerMap; repoRoot: string; registry: ToolRegistry }) {
    this.handlers = options.handlers;
    this.registry = options.registry;
  }

  /**
   * Execute a single tool call within a turn execution context.
   *
   * Converts the ParsedToolCall into a typed AgentAction, checks for
   * repeated bash commands, then dispatches to the appropriate handler.
   * Falls back to the ToolRegistry for custom/unknown tools.
   */
  async execute(
    call: ParsedToolCall,
    context: ExecutionContext,
    bashCounts?: Map<string, number>,
  ): Promise<AgentToolExecutionResult> {
    // Repetition guard for bash (checked before dispatch)
    if (bashCounts && call.name === 'bash') {
      const repeated = detectRepeatedBash(call, bashCounts);
      if (repeated) return repeated;
    }

    // Convert to typed action
    const action = toAgentAction(call);

    let result: AgentToolExecutionResult;

    if (action) {
      const handler = this.handlers.get(action.kind);
      if (handler) {
        result = await handler(action, context);
      } else {
        // Fallback: unknown or unhandled tool — use registry
        const toolResult = await this.registry.execute(call.name, call.arguments);
        result = { success: toolResult.success, toolResult, error: toolResult.error };
      }
    } else {
      const toolResult = await this.registry.execute(call.name, call.arguments);
      result = { success: toolResult.success, toolResult, error: toolResult.error };
    }

    // Reset bash repetition counter after meaningful progress (edit/write).
    // A successful file mutation indicates the task is advancing, so identical
    // bash commands after this point are part of a new mini-workflow (e.g.
    // edit → make test → edit → make test) rather than a stuck loop.
    if (bashCounts && result.success && (call.name === 'edit' || call.name === 'write')) {
      bashCounts.clear();
    }

    return result;
  }
}

// ─── Bash repetition detection ────────────────────────────

const MAX_IDENTICAL_BASH_COMMANDS_PER_TURN = 3;

function detectRepeatedBash(call: ParsedToolCall, counts: Map<string, number>): AgentToolExecutionResult | null {
  const command = typeof call.arguments.command === 'string' ? call.arguments.command.trim() : null;
  if (!command) return null;
  const key = normalizeShellCommand(command);
  const seen = counts.get(key) ?? 0;
  counts.set(key, seen + 1);
  if (seen < MAX_IDENTICAL_BASH_COMMANDS_PER_TURN) return null;

  return toolFailure(
    'bash',
    `Bash loop detected: command repeated ${seen + 1} times without completing the task: ${command}`,
  );
}

function normalizeShellCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}
