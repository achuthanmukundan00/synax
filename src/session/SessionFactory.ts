/**
 * SessionFactory — shared Session construction for chat and run-task commands.
 *
 * Extracts duplicated observability plumbing into a single factory so both
 * `chat.ts` and `run-task.ts` get identical wiring:
 *   - EventStore + SpanTracer
 *   - TokenCounter + CostTracker
 *   - HolographicMemory
 *   - Structured logger
 *   - Skill auto-discovery + config-based skills
 *   - Context strategy resolution
 *   - wrappedOnEvent that persists every AgentEvent to EventStore
 *
 * This prevents feature drift between the two code paths.
 */

import { createEventStore } from '../store/EventStore';
import { SpanTracer } from '../telemetry/SpanTracer';
import { TokenCounter } from '../metrics/TokenCounter';
import { CostTracker } from '../metrics/CostTracker';
import { resolveStrategy, getStrategy, type ContextStrategyMode } from '../context/ContextStrategy';
import { createLogger, type Logger } from '../logging/index';
import { discoverSkills, buildSkillMessages } from '../skills/SkillLoader';
import { loadSkills } from '../agent/skills';
import { loadSynaxConfig } from '../config/load-config';
import { eventNow, type AgentEvent } from '../agent/events';
import { createSession as createStoreSession, generateSessionId, type SessionEvent } from '../sessions/session-store';
import { Session } from './Session';
import type { AgentConversation } from './types';
import type { HolographicMemory } from '../memory/HolographicMemory';
import type { ProjectConfig } from '../config/project';
import type { AgentActivity, AgentBudgetSnapshot } from './types';
import type { RunMode } from '../agent/task-policy';
import type { PatchApprovalDecision } from '../actions/types';
import type { PatchPreview } from '../agent/patch';

// ─── Component bag ───────────────────────────────────────────────────────────

/**
 * All observability components created by the factory.
 * Both commands receive the same interfaces.
 */
export interface SessionComponents {
  sessionId: string;
  eventStore: ReturnType<typeof createEventStore>;
  tracer: SpanTracer;
  tokenCounter: TokenCounter;
  costTracker: CostTracker;
  memory: HolographicMemory | null;
  logger: Logger;
  skillMessages: string[] | undefined;
  /** Context strategy based on model window. */
  strategyReserveTokens: number;
  strategyWindowOverride?: number;
  /** Context strategy mode for tuning compaction behavior. */
  strategyMode: ContextStrategyMode;
  /** The model's actual context window in tokens (used for budget sizing). */
  modelContextWindow: number;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface CreateSessionComponentsOptions {
  repoRoot: string;
  modelId: string;
  contextWindow: number;
  /** Provider metadata for cost tracking. */
  modelContextWindow?: number;
  noSkills?: boolean;
  strategyOverride?: string;
  /** Human-readable title for the session-store entry. */
  title?: string;
  /** Pre-generated session ID. When provided, skips auto-generation. */
  sessionId?: string;
}

/**
 * Create the shared observability components.
 *
 * Creates an EventStore, SpanTracer, TokenCounter, CostTracker, logger,
 * discovers skills, and resolves context strategy. Every session from
 * chat or run-task gets the same components.
 */
export function createSessionComponents(options: CreateSessionComponentsOptions): SessionComponents {
  const sessionId = options.sessionId ?? generateSessionId();
  const eventStore = createEventStore();
  const tracer = new SpanTracer({ sessionId, eventStore });
  const tokenCounter = new TokenCounter();
  const costTracker = new CostTracker(tokenCounter, options.modelId);
  const memory = eventStore?.memory ?? null;
  const logger = eventStore ? createLogger({ sessionId, eventStore }) : createLogger();

  // ── Skills: auto-discovered + config-based ────────────────
  let skillMessages: string[] | undefined;
  if (!options.noSkills) {
    const autoMessages: string[] = [];
    try {
      const discovery = discoverSkills(options.repoRoot);
      if (discovery.loaded.length > 0) {
        autoMessages.push(...buildSkillMessages(discovery.loaded));
      }
      if (discovery.errors.length > 0) {
        for (const err of discovery.errors) {
          logger.warn('Skill discovery error', { error: err });
        }
      }
    } catch {
      // Auto-discovery is best-effort
    }

    const configMessages: string[] = [];
    try {
      const effectiveConfig = loadSynaxConfig(options.repoRoot);
      if (effectiveConfig.skills.enabled.length > 0) {
        const result = loadSkills(effectiveConfig.skills, options.repoRoot);
        configMessages.push(...result.systemMessages);
      }
    } catch {
      // Config loading is best-effort
    }

    skillMessages = [...autoMessages, ...configMessages];
    if (skillMessages.length === 0) skillMessages = undefined;
  }

  // ── Context strategy ─────────────────────────────────────
  const modelContextWindow = options.modelContextWindow ?? options.contextWindow ?? 131072;
  const strategy = options.strategyOverride
    ? (getStrategy(options.strategyOverride) ?? resolveStrategy(modelContextWindow))
    : resolveStrategy(modelContextWindow);

  return {
    sessionId,
    eventStore,
    tracer,
    tokenCounter,
    costTracker,
    memory,
    logger,
    skillMessages,
    strategyReserveTokens: strategy.reserveTokens,
    strategyWindowOverride: strategy.contextWindowOverride,
    strategyMode: strategy.mode,
    modelContextWindow,
  };
}

// ─── Session factory ─────────────────────────────────────────────────────────

export interface CreateAgentSessionOptions {
  repoRoot: string;
  client: ReturnType<typeof import('../llm/provider-factory').createLLMClient>['client'];
  config: ProjectConfig;
  components: SessionComponents;
  mode?: RunMode;
  /** User-facing onActivity callback (CLI logging or TUI). */
  onActivity?: (activity: AgentActivity) => void;
  /** User-facing onEvent callback (TUI sink). */
  onEvent?: (event: AgentEvent) => void;
  /** User-facing onBudget callback. */
  onBudget?: (snapshot: AgentBudgetSnapshot) => void;
  approvePatch?: (preview: PatchPreview) => PatchApprovalDecision | Promise<PatchApprovalDecision>;
  ensureCheckpoint?: () => Promise<unknown>;
  abortSignal?: AbortSignal;
  onSteeringCheck?: () => string | undefined;
  maxBudget?: number;
  /** External event sink for session-store JSONL and TUI forwarding. */
  onSessionEvent?: (event: SessionEvent) => void;
  /** Human-readable title for the session-store entry. */
  title?: string;
  /** Existing conversation to reuse (chat mode shares across turns). */
  conversation?: AgentConversation;
  /** Skip EventStore and session-store registration (caller handles it). */
  skipStoreRegistration?: boolean;
}

export interface AgentSessionResult {
  session: Session;
  /** Persists every AgentEvent to EventStore and forwards to session-store JSONL. */
  wrappedOnEvent: (event: AgentEvent) => void;
}

/**
 * Create a fully-wired Agent Session with all observability features
 * enabled. Both `chat.ts` and `run-task.ts` use this factory to avoid
 * diverging Session construction.
 */
export function createAgentSession(options: CreateAgentSessionOptions): AgentSessionResult {
  const { components } = options;

  // Register in EventStore
  if (components.eventStore && !options.skipStoreRegistration) {
    components.eventStore.startSession({
      id: components.sessionId,
      repoRoot: options.repoRoot,
      mode: options.mode ?? 'patch',
      model: options.config.provider?.model ?? '',
      createdAt: new Date().toISOString(),
    });
  }

  // Register in session-store for /resume discoverability
  if (!options.skipStoreRegistration) {
    try {
      createStoreSession({
        id: components.sessionId,
        workspacePath: options.repoRoot,
        title: options.title ?? 'New session',
        activeModel: options.config.provider?.model ?? undefined,
      });
    } catch {
      // Best-effort
    }
  }

  // ── Event wiring ──────────────────────────────────────────
  let eventSequence = 0;
  const wrappedOnEvent = (event: AgentEvent): void => {
    // Forward to user callback
    options.onEvent?.(event);

    // Persist to EventStore
    if (components.eventStore) {
      eventSequence += 1;
      components.eventStore.appendEvent(components.sessionId, event, eventSequence);
    }

    // Forward to session-store JSONL (chat mode)
    if (options.onSessionEvent) {
      const sessionEvent = agentEventToSessionEvent(event);
      if (sessionEvent) {
        options.onSessionEvent(sessionEvent);
      }
    }
  };

  // ── Build Session ─────────────────────────────────────────
  const session = new Session({
    repoRoot: options.repoRoot,
    client: options.client,
    mode: options.mode,
    sessionId: components.sessionId,
    memory: components.memory,
    maxToolCalls: options.config.maxToolCalls,
    bashEnabled: options.config.tools?.bash?.enabled,
    skillMessages: components.skillMessages,
    conversation: options.conversation,
    logger: components.logger,
    tracer: components.tracer,
    tokenCounter: components.tokenCounter,
    costTracker: components.costTracker,
    maxBudget: options.maxBudget,
    contextBudget: {
      contextBudgetTokens: options.config.contextBudgetTokens,
      contextWindowTokens:
        components.strategyWindowOverride ??
        components.modelContextWindow ??
        options.config.contextWindowTokens ??
        options.config.contextBudgetTokens,
      reservedOutputTokens: options.config.reservedOutputTokens ?? components.strategyReserveTokens,
      keepRecentTokens: options.config.keepRecentTokens,
      maxSingleReadResultTokens: options.config.maxSingleReadResultTokens,
      maxTotalReadResultTokensPerTurn: options.config.maxTotalReadResultTokensPerTurn,
      strategyReserveTokens: components.strategyReserveTokens,
      strategyWindowOverride: components.strategyWindowOverride,
      strategyMode: components.strategyMode,
    },
    onActivity: options.onActivity,
    onEvent: wrappedOnEvent,
    onBudget: options.onBudget
      ? options.onBudget
      : (snapshot: AgentBudgetSnapshot) => {
          wrappedOnEvent({
            type: 'context_budget_updated',
            timestamp: eventNow(),
            estimatedInputTokens: snapshot.estimatedInputTokens,
            inputLimit: snapshot.inputLimit,
            contextWindowTokens: snapshot.contextWindowTokens,
            reservedOutputTokens: snapshot.reservedOutputTokens,
            step: snapshot.step,
          });
        },
    approvePatch: options.approvePatch,
    ensureCheckpoint: options.ensureCheckpoint,
    abortSignal: options.abortSignal,
    onSteeringCheck: options.onSteeringCheck,
  });

  return { session, wrappedOnEvent };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert an AgentEvent to a SessionEvent for JSONL persistence.
 * Returns null for event types that shouldn't be stored in JSONL.
 */
function agentEventToSessionEvent(event: AgentEvent): SessionEvent | null {
  const at = event.timestamp || new Date().toISOString();

  switch (event.type) {
    case 'assistant_message': {
      const content = 'content' in event ? (event as { content?: string }).content : undefined;
      if (!content) return null;
      return { type: 'assistant_message', at, content };
    }
    case 'tool_started': {
      const toolEvent = event as { toolName: string; summary: string; toolCallId: string };
      return {
        type: 'tool_call',
        at,
        name: toolEvent.toolName,
        args: { summary: toolEvent.summary, toolCallId: toolEvent.toolCallId },
      };
    }
    case 'tool_finished': {
      const toolFinishedEvent = event as {
        toolName: string;
        summary: string;
        status: 'ok' | 'error';
        detail?: string;
        toolCallId: string;
      };
      return {
        type: 'tool_result',
        at,
        name: toolFinishedEvent.toolName,
        result: {
          status: toolFinishedEvent.status,
          summary: toolFinishedEvent.summary,
          detail: toolFinishedEvent.detail,
          toolCallId: toolFinishedEvent.toolCallId,
        },
      };
    }
    default:
      return null;
  }
}
