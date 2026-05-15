import { type AgentMessage } from '../session/Session';
import { type InspectionLedger } from '../tools/ledger';
import { DeterministicCompactor } from '../compaction/DeterministicCompactor';
import type { TokenCounter } from '../metrics/TokenCounter';

export interface ContextBudgetSettings {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  keepRecentTokens: number;
  maxSingleReadResultTokens: number;
  maxTotalReadResultTokensPerTurn: number;
  keepRecentToolTurns?: number;
  /** Fraction of effective input limit at which proactive assembly compaction triggers. 0 = always, 1 = never. Default 0.8. */
  assemblyCompactionThreshold?: number;
  /** Strategy-based reserve override (internal, set by run-task). */
  strategyReserveTokens?: number;
  /** Strategy-based window override for 'off' mode (internal). */
  strategyWindowOverride?: number;
  /** Context strategy mode for tuning compaction behavior. */
  strategyMode?: 'aggressive' | 'moderate' | 'light' | 'none' | 'off';
}

export interface CompactionRecord {
  type: 'compaction';
  stage: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  tokensAfter: number;
  createdAt: string;
}

export interface TokenLedger {
  /** Token count at last measurement point. */
  lastKnownTokenCount: number;
  /** Index in messages array where lastKnownTokenCount was measured. */
  lastMeasuredIndex: number;
}

export interface RequestBudgetErrorDetails {
  estimatedInputTokens: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  effectiveInputLimit: number;
  largestContributors: string[];
  compactionStage: number;
}

const DEFAULT_SETTINGS: ContextBudgetSettings = {
  contextWindowTokens: 131072,
  reservedOutputTokens: 8192,
  keepRecentTokens: 20000,
  maxSingleReadResultTokens: 12000,
  maxTotalReadResultTokensPerTurn: 96000,
  keepRecentToolTurns: 3,
};

const MAX_SUMMARY_CHARS = 8000;
const MAX_STRUCTURED_SECTION_CHARS = 2000;
const CHARS_PER_ESTIMATED_TOKEN = 4;
const CJK_CHARS_PER_ESTIMATED_TOKEN = 1.5;
const DENSE_TEXT_CHARS_PER_ESTIMATED_TOKEN = 2;

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

export function resolveContextBudgetSettings(config: {
  contextBudgetTokens?: number;
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
  keepRecentTokens?: number;
  maxSingleReadResultTokens?: number;
  maxTotalReadResultTokensPerTurn?: number;
  keepRecentToolTurns?: number;
  assemblyCompactionThreshold?: number;
  /** Strategy-based reserve override. Takes precedence over explicit reservedOutputTokens. */
  strategyReserveTokens?: number;
  /** Strategy-based window override (for 'off' mode). */
  strategyWindowOverride?: number;
  /** Strategy mode for compaction tuning. */
  strategyMode?: 'aggressive' | 'moderate' | 'light' | 'none' | 'off';
}): ContextBudgetSettings {
  const contextWindowTokens =
    config.strategyWindowOverride ??
    config.contextWindowTokens ??
    config.contextBudgetTokens ??
    DEFAULT_SETTINGS.contextWindowTokens;

  const reservedOutputTokens =
    config.strategyReserveTokens ?? config.reservedOutputTokens ?? DEFAULT_SETTINGS.reservedOutputTokens;

  return {
    contextWindowTokens,
    reservedOutputTokens,
    keepRecentTokens: config.keepRecentTokens ?? DEFAULT_SETTINGS.keepRecentTokens,
    maxSingleReadResultTokens: config.maxSingleReadResultTokens ?? DEFAULT_SETTINGS.maxSingleReadResultTokens,
    maxTotalReadResultTokensPerTurn:
      config.maxTotalReadResultTokensPerTurn ?? DEFAULT_SETTINGS.maxTotalReadResultTokensPerTurn,
    keepRecentToolTurns: config.keepRecentToolTurns ?? DEFAULT_SETTINGS.keepRecentToolTurns,
    assemblyCompactionThreshold: config.assemblyCompactionThreshold ?? 0.8,
    strategyMode: config.strategyMode,
  };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkChars = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  if (cjkChars > text.length * 0.2) {
    const nonCjkChars = text.length - cjkChars;
    return Math.ceil(cjkChars / CJK_CHARS_PER_ESTIMATED_TOKEN + nonCjkChars / CHARS_PER_ESTIMATED_TOKEN);
  }

  const compactChars = text.replace(/\s/g, '').length;
  const denseRatio = compactChars / text.length;
  const longTokenMatches = text.match(/[A-Za-z0-9+/=_-]{80,}/g);
  const longTokenChars = longTokenMatches?.reduce((sum, match) => sum + match.length, 0) ?? 0;
  if (denseRatio > 0.85 && longTokenChars > text.length * 0.25) {
    return Math.ceil(text.length / DENSE_TEXT_CHARS_PER_ESTIMATED_TOKEN);
  }

  return Math.ceil(text.length / CHARS_PER_ESTIMATED_TOKEN);
}

export function estimateMessageTokens(message: AgentMessage): number {
  return estimateTokens(serializeMessage(message));
}

export function estimateRequestTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

// ---------------------------------------------------------------------------
// Incremental token accounting
// ---------------------------------------------------------------------------

export function createTokenLedger(): TokenLedger {
  return { lastKnownTokenCount: 0, lastMeasuredIndex: -1 };
}

/**
 * Estimate tokens incrementally: full estimate up to lastMeasuredIndex,
 * plus incremental estimate for messages beyond that point.
 */
export function estimateIncrementalTokens(messages: AgentMessage[], ledger: TokenLedger): number {
  if (ledger.lastMeasuredIndex < 0) {
    const full = estimateRequestTokens(messages);
    ledger.lastKnownTokenCount = full;
    ledger.lastMeasuredIndex = messages.length - 1;
    return full;
  }

  if (messages.length - 1 < ledger.lastMeasuredIndex) {
    // Message history shrank (e.g. compaction or transient assembly-only messages
    // were previously measured). Re-estimate from scratch to avoid stale inflation.
    const full = estimateRequestTokens(messages);
    ledger.lastKnownTokenCount = full;
    ledger.lastMeasuredIndex = messages.length - 1;
    return full;
  }

  if (ledger.lastMeasuredIndex >= messages.length - 1) {
    // No new messages; reuse known count but verify with a cheap fallback
    // to guard against subtle drift (only re-estimate last few messages).
    const driftCheck = estimateRequestTokens(messages.slice(Math.max(0, messages.length - 5)));
    const driftBaseline = estimateRequestTokens(
      messages.slice(Math.max(0, ledger.lastMeasuredIndex - 4), ledger.lastMeasuredIndex + 1),
    );
    if (Math.abs(driftCheck - driftBaseline) > 50) {
      // Fallback to full re-estimate
      const full = estimateRequestTokens(messages);
      ledger.lastKnownTokenCount = full;
      ledger.lastMeasuredIndex = messages.length - 1;
      return full;
    }
    return ledger.lastKnownTokenCount;
  }

  // Only estimate new messages since last measurement
  const newMessages = messages.slice(ledger.lastMeasuredIndex + 1);
  const newTokens = estimateRequestTokens(newMessages);
  const total = ledger.lastKnownTokenCount + newTokens;

  // Store updated measurement
  ledger.lastKnownTokenCount = total;
  ledger.lastMeasuredIndex = messages.length - 1;

  return total;
}

export function resetTokenLedger(ledger: TokenLedger): void {
  ledger.lastKnownTokenCount = 0;
  ledger.lastMeasuredIndex = -1;
}

// ---------------------------------------------------------------------------
// Dynamic tail sizing
// ---------------------------------------------------------------------------

/**
 * Compute target tail size based on effective input limit.
 * Uses min(keepRecentTokens, 0.4 * (contextWindow - reservedOutput)).
 */
export function computeTailTokens(settings: ContextBudgetSettings): number {
  const effectiveLimit = settings.contextWindowTokens - settings.reservedOutputTokens;
  const dynamicTail = Math.floor(0.4 * effectiveLimit);
  return Math.min(settings.keepRecentTokens, dynamicTail);
}

// ---------------------------------------------------------------------------
// Contributor reporting
// ---------------------------------------------------------------------------

export function summarizeLargestContributors(messages: AgentMessage[], top = 3): string[] {
  const entries = messages.map((message, index) => ({
    index,
    role: message.role,
    tokens: estimateMessageTokens(message),
    label: contributorLabel(message),
  }));

  return entries
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, top)
    .map((entry) => `${entry.label} ~${entry.tokens}`);
}

export function formatContextBudgetError(details: RequestBudgetErrorDetails): string {
  const base =
    `context budget exceeded before model call (stage ${details.compactionStage}): estimated ${details.estimatedInputTokens} input tokens, ` +
    `limit ${details.effectiveInputLimit} (context ${details.contextWindowTokens} - reserved ${details.reservedOutputTokens}).`;
  const contributors =
    details.largestContributors.length > 0 ? ` Largest contributors: ${details.largestContributors.join(', ')}.` : '';
  return `${base}${contributors} ` + 'Narrow the task, clear context, or inspect targeted files.';
}

// ---------------------------------------------------------------------------
// Multi-stage compaction
// ---------------------------------------------------------------------------

export type CompactionStage = 0 | 1 | 2 | 3 | 4;

export interface CompactionResult {
  activeMessages: AgentMessage[];
  compaction: CompactionRecord | null;
  stage: CompactionStage;
  tokensAfter: number;
  /** Optional deterministic compaction stats (set on stage 0). */
  deterministicStats?: { savedTokens: number; techniques: string[] };
}

/**
 * Stage 1: Normal compaction with dynamic tail sizing.
 * Stage 2: Reduced tail (60% of stage 1 tail, then 40%).
 * Stage 3: Aggressively shrink summary + minimal tail.
 * Stage 4: Fail-closed — return what we have but signal error upstream.
 */
export function compactMessagesMultiStage(messages: AgentMessage[], settings: ContextBudgetSettings): CompactionResult {
  const effectiveLimit = settings.contextWindowTokens - settings.reservedOutputTokens;

  // Strategy: none/off — skip all compaction entirely
  if (settings.strategyMode === 'none' || settings.strategyMode === 'off') {
    const tokensAfter = estimateRequestTokens(messages);
    return { activeMessages: messages, compaction: null, stage: 0, tokensAfter };
  }

  // Strategy: aggressive/moderate/light/undefined — full multi-stage with deterministic pre-pass.
  // Light mode still starts with deterministic compaction, but falls through to
  // summarizing stages instead of failing closed at stage 0.
  // Stage 0: deterministic zero-token compression
  const compactor = new DeterministicCompactor();
  const compacted = compactor.compact(messages);
  if (compacted.stats.savedTokens > 0) {
    const tokensAfter = estimateRequestTokens(messages);
    if (tokensAfter <= effectiveLimit) {
      return {
        activeMessages: messages,
        compaction: null,
        stage: 0,
        tokensAfter,
        deterministicStats: {
          savedTokens: compacted.stats.savedTokens,
          techniques: compacted.stats.techniques,
        },
      };
    }
  }

  // Stage 1: normal compaction with dynamic tail sizing
  const stage1Tail = computeTailTokens(settings);
  const stage1 = tryCompactStage(messages, settings, stage1Tail, effectiveLimit, 1);
  if (stage1.tokensAfter <= effectiveLimit) return stage1;

  // Stage 2: reduced tail (60% of stage1)
  const stage2Tail = Math.floor(stage1Tail * 0.6);
  const stage2 = tryCompactStage(messages, settings, Math.max(50, stage2Tail), effectiveLimit, 2);
  if (stage2.tokensAfter <= effectiveLimit) return stage2;

  // Stage 2b: further reduced tail (40% of stage1)
  const stage2bTail = Math.floor(stage1Tail * 0.4);
  const stage2b = tryCompactStage(messages, settings, Math.max(50, stage2bTail), effectiveLimit, 2);
  if (stage2b.tokensAfter <= effectiveLimit) return stage2b;

  // Stage 3: aggressive summary shrink + minimal tail
  const stage3Tail = Math.floor(computeTailTokens(settings) * 0.25);
  const stage3 = tryCompactStageAggressive(messages, settings, Math.max(30, stage3Tail), effectiveLimit, 3);
  if (stage3.tokensAfter <= effectiveLimit) return stage3;

  // Stage 4: fail-closed
  return failCompact(messages, settings, effectiveLimit, 4);
}

function tryCompactStage(
  messages: AgentMessage[],
  settings: ContextBudgetSettings,
  keepRecentTokens: number,
  _effectiveLimit: number,
  stage: CompactionStage,
): CompactionResult {
  const stageSettings: ContextBudgetSettings = { ...settings, keepRecentTokens };
  const result = compactMessages(messages, stageSettings);

  if (!result.compaction) {
    // No compaction needed or possible
    const tokens = estimateRequestTokens(messages);
    return {
      activeMessages: messages,
      compaction: null,
      stage,
      tokensAfter: tokens,
    };
  }

  const tokensAfter = estimateRequestTokens(result.activeMessages);
  return {
    activeMessages: result.activeMessages,
    compaction: {
      ...result.compaction,
      stage,
      tokensAfter,
    },
    stage,
    tokensAfter,
  };
}

function tryCompactStageAggressive(
  messages: AgentMessage[],
  settings: ContextBudgetSettings,
  keepRecentTokens: number,
  _effectiveLimit: number,
  stage: CompactionStage,
): CompactionResult {
  const stageSettings: ContextBudgetSettings = { ...settings, keepRecentTokens };
  const result = compactMessagesAggressive(messages, stageSettings);

  if (!result.compaction) {
    const tokens = estimateRequestTokens(messages);
    return { activeMessages: messages, compaction: null, stage, tokensAfter: tokens };
  }

  const tokensAfter = estimateRequestTokens(result.activeMessages);
  return {
    activeMessages: result.activeMessages,
    compaction: {
      ...result.compaction,
      stage,
      tokensAfter,
    },
    stage,
    tokensAfter,
  };
}

function failCompact(
  messages: AgentMessage[],
  _settings: ContextBudgetSettings,
  _effectiveLimit: number,
  stage: CompactionStage,
): CompactionResult {
  const tokens = estimateRequestTokens(messages);
  return {
    activeMessages: messages,
    compaction: null,
    stage,
    tokensAfter: tokens,
  };
}

// ---------------------------------------------------------------------------
// Oversized tool result pre-compaction
// ---------------------------------------------------------------------------

/**
 * Compact individual tool results that are disproportionately large relative
 * to the context budget. A single 10 KB stdout dump shouldn't prevent the
 * tail-truncation logic from keeping recent conversational context.
 *
 * Returns a new messages array (does not mutate the original).
 */
function compactOversizedToolResults(messages: AgentMessage[], settings: ContextBudgetSettings): AgentMessage[] {
  const effectiveLimit = settings.contextWindowTokens - settings.reservedOutputTokens;
  // Only compact tool results larger than 25% of the effective budget.
  // This keeps normal-sized results intact while catching stdout dumps,
  // massive file reads, and other single-message budget dominators.
  const thresholdTokens = Math.max(50, Math.floor(effectiveLimit * 0.25));

  let changed = false;
  const result = messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    const tokens = estimateMessageTokens(msg);
    if (tokens <= thresholdTokens) return msg;
    const compacted = compactToolResultMessage(msg);
    if (compacted) {
      changed = true;
      return compacted;
    }
    return msg;
  });

  return changed ? result : messages;
}

// ---------------------------------------------------------------------------
// Core compaction logic
// ---------------------------------------------------------------------------

export function compactMessages(
  messages: AgentMessage[],
  settings: ContextBudgetSettings,
): { activeMessages: AgentMessage[]; compaction: CompactionRecord | null } {
  if (messages.length <= 2) return { activeMessages: messages, compaction: null };

  // Pre-compact oversized individual tool results so a single large
  // result doesn't dominate the budget and prevent tail truncation.
  const preCompacted = compactOversizedToolResults(messages, settings);

  const system = preCompacted[0];
  const body = preCompacted.slice(1);
  let keptTokens = 0;
  let keepFrom = body.length;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    keptTokens += estimateMessageTokens(body[index]);
    keepFrom = index;
    if (keptTokens >= settings.keepRecentTokens) break;
  }

  keepFrom = adjustKeepFromForToolIntegrity(body, keepFrom);
  if (keepFrom <= 0) return { activeMessages: messages, compaction: null };

  const older = body.slice(0, keepFrom);
  const recent = body.slice(keepFrom);
  const summary = buildStructuredCompactionSummary(older);
  const summaryMessage: AgentMessage = {
    role: 'system',
    content: `Compacted session summary (deterministic, stage 1):\n${summary}`,
  };

  return {
    activeMessages: [system, summaryMessage, ...recent],
    compaction: {
      type: 'compaction',
      stage: 1,
      summary,
      firstKeptEntryId: `msg:${keepFrom + 1}`,
      tokensBefore: estimateRequestTokens(messages),
      tokensAfter: 0,
      createdAt: new Date().toISOString(),
    },
  };
}

function compactMessagesAggressive(
  messages: AgentMessage[],
  settings: ContextBudgetSettings,
): { activeMessages: AgentMessage[]; compaction: CompactionRecord | null } {
  if (messages.length <= 2) return { activeMessages: messages, compaction: null };

  // Pre-compact oversized individual tool results
  const preCompacted = compactOversizedToolResults(messages, settings);

  const system = preCompacted[0];
  const body = preCompacted.slice(1);
  let keptTokens = 0;
  let keepFrom = body.length;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    keptTokens += estimateMessageTokens(body[index]);
    keepFrom = index;
    if (keptTokens >= settings.keepRecentTokens) break;
  }

  keepFrom = adjustKeepFromForToolIntegrity(body, keepFrom);
  if (keepFrom <= 0) return { activeMessages: messages, compaction: null };

  const older = body.slice(0, keepFrom);
  const recent = body.slice(keepFrom);

  // Aggressive summary: hard cap at 1200 chars
  const summary = buildAggressiveSummary(older);
  const summaryMessage: AgentMessage = {
    role: 'system',
    content: `Compacted session summary (deterministic, aggressive):\n${summary}`,
  };

  return {
    activeMessages: [system, summaryMessage, ...recent],
    compaction: {
      type: 'compaction',
      stage: 3,
      summary,
      firstKeptEntryId: `msg:${keepFrom + 1}`,
      tokensBefore: estimateRequestTokens(messages),
      tokensAfter: 0,
      createdAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Truncation for token budget
// ---------------------------------------------------------------------------

export function truncateForTokenBudget(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  const maxChars = Math.max(1, Math.floor(maxTokens * CHARS_PER_ESTIMATED_TOKEN));
  return { text: text.slice(0, maxChars), truncated: true };
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeMessage(message: AgentMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    tool_call_id: message.tool_call_id,
    name: message.name,
    tool_calls: message.tool_calls,
    reasoning_content: message.reasoning_content,
  });
}

function contributorLabel(message: AgentMessage): string {
  if (message.role !== 'tool') return message.role;
  const parsed = tryParseJson(message.content);
  if (!parsed || typeof parsed !== 'object') return 'tool result';
  const toolName = (parsed as { toolName?: unknown }).toolName;
  const output = (parsed as { output?: unknown }).output;
  const path = output && typeof output === 'object' ? (output as { path?: unknown }).path : undefined;
  const pathLabel = typeof path === 'string' ? ` ${path}` : '';
  return `tool ${typeof toolName === 'string' ? toolName : 'result'}${pathLabel}`;
}

// ---------------------------------------------------------------------------
// Tool-call / tool-result integrity enforcement
// ---------------------------------------------------------------------------

/**
 * Adjusts the keepFrom boundary to ensure tool-call/tool-result pairs stay intact.
 *
 * Rule 0: XML path — if a kept user message carries _tool_result_ids,
 *          include its matching assistant (found via _tool_call_ids marker).
 *
 * Rule 1: If a kept tool_result references an assistant tool_call that would be
 *          compacted away, expand the kept window to include that assistant.
 *
 * Rule 2: If a kept assistant has tool_calls whose results would be compacted
 *          away AND that assistant is the last assistant (no further assistant
 *          with tool_calls completes the turn), then expand to exclude the
 *          assistant (move keepFrom past it), since keeping a dangling
 *          tool_call is worse than dropping the whole turn.
 *
 * Returns the adjusted keepFrom index.
 */
function adjustKeepFromForToolIntegrity(messages: AgentMessage[], initialKeepFrom: number): number {
  let keepFrom = initialKeepFrom;
  const maxIterations = messages.length + 10; // safety valve
  let iterations = 0;

  while (keepFrom < messages.length && iterations < maxIterations) {
    iterations += 1;
    let changed = false;
    const kept = messages.slice(keepFrom);

    // Rule 0: XML path — orphan _tool_result_ids → include matching assistant
    const keptXmlResultIds = new Set(
      kept.flatMap((m) => {
        const ids = extractXmlToolResultIds(m);
        return ids;
      }),
    );
    for (const id of keptXmlResultIds) {
      const assistantIndex = findAssistantWithXmlToolCallId(messages, id);
      if (assistantIndex !== -1 && assistantIndex < keepFrom) {
        keepFrom = assistantIndex;
        changed = true;
      }
    }

    // Rule 1: orphan tool_result → include its assistant tool_call
    const keptToolIds = new Set(
      kept
        .filter((message) => message.role === 'tool' && typeof message.tool_call_id === 'string')
        .map((message) => message.tool_call_id as string),
    );
    for (const toolCallId of keptToolIds) {
      const assistantIndex = findAssistantWithToolCall(messages, toolCallId);
      if (assistantIndex !== -1 && assistantIndex < keepFrom) {
        keepFrom = assistantIndex;
        changed = true;
      }
    }

    // Rule 2: orphan assistant tool_call (no matching tool_result in kept)
    const keptAssistants = kept
      .map((message, index) => ({ message, index: keepFrom + index }))
      .filter((entry) => entry.message.role === 'assistant' && hasToolCalls(entry.message));
    for (const assistant of keptAssistants) {
      const ids = extractToolCallIds(assistant.message);
      let hasAllResults = true;
      for (const id of ids) {
        const hasResult = kept.some((message) => message.role === 'tool' && message.tool_call_id === id);
        if (!hasResult) {
          hasAllResults = false;
          break;
        }
      }
      if (!hasAllResults) {
        // Check if there's a later assistant with tool_calls that would make
        // dropping this turn acceptable
        const hasLaterTurn = messages
          .slice(assistant.index + 1)
          .some((message) => message.role === 'assistant' && hasToolCalls(message));
        if (!hasLaterTurn) {
          // This is the last tool-call turn. We must either:
          // a) expand keepFrom to include the tool results (impossible if already included)
          // b) move keepFrom past this assistant to drop the whole turn
          keepFrom = Math.min(messages.length, assistant.index + 1);
          changed = true;
        }
      }
    }

    if (!changed) break;
  }

  // P5: If we hit the iteration limit, the tool-pair graph is too tangled
  // to resolve safely. Fall back to the least aggressive position that still
  // preserves some compaction rather than silently keeping everything.
  if (iterations >= maxIterations) return findProtocolSafeCompactionBoundary(messages, initialKeepFrom);

  // If we expanded so far that nothing will be compacted, return 0
  if (keepFrom <= 0) return 0;

  if (!isProtocolSafeCompactionBoundary(messages, keepFrom)) {
    return findProtocolSafeCompactionBoundary(messages, keepFrom);
  }

  return keepFrom;
}

function findProtocolSafeCompactionBoundary(messages: AgentMessage[], preferredKeepFrom: number): number {
  const start = Math.max(1, Math.min(preferredKeepFrom, messages.length));
  for (let keepFrom = start; keepFrom <= messages.length; keepFrom += 1) {
    if (isProtocolSafeCompactionBoundary(messages, keepFrom)) return keepFrom;
  }
  return messages.length;
}

function isProtocolSafeCompactionBoundary(messages: AgentMessage[], keepFrom: number): boolean {
  const kept = messages.slice(keepFrom);
  const keptToolCallIds = new Set<string>();
  const keptToolResultIds = new Set<string>();
  const keptXmlCallIds = new Set<string>();
  const keptXmlResultIds = new Set<string>();

  for (const message of kept) {
    for (const id of extractToolCallIds(message)) keptToolCallIds.add(id);
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      keptToolResultIds.add(message.tool_call_id);
    }
    for (const id of extractXmlToolCallIds(message)) keptXmlCallIds.add(id);
    for (const id of extractXmlToolResultIds(message)) keptXmlResultIds.add(id);
  }

  for (const id of keptToolResultIds) {
    if (!keptToolCallIds.has(id)) return false;
  }
  for (const id of keptToolCallIds) {
    if (!keptToolResultIds.has(id)) return false;
  }
  for (const id of keptXmlResultIds) {
    if (!keptXmlCallIds.has(id)) return false;
  }

  return true;
}

function extractXmlToolResultIds(message: AgentMessage): string[] {
  const ids = (message as { _tool_result_ids?: unknown })._tool_result_ids;
  if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string');
  return [];
}

function extractXmlToolCallIds(message: AgentMessage): string[] {
  const ids = (message as { _tool_call_ids?: unknown })._tool_call_ids;
  if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string');
  return [];
}

function findAssistantWithXmlToolCallId(messages: AgentMessage[], toolCallId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (extractXmlToolCallIds(message).includes(toolCallId)) return index;
  }
  return -1;
}

function findAssistantWithToolCall(messages: AgentMessage[], toolCallId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !hasToolCalls(message)) continue;
    if (extractToolCallIds(message).includes(toolCallId)) return index;
  }
  return -1;
}

function hasToolCalls(message: AgentMessage): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function extractToolCallIds(message: AgentMessage): string[] {
  if (!Array.isArray(message.tool_calls)) return [];
  const ids: string[] = [];
  for (const call of message.tool_calls as Array<{ id?: unknown }>) {
    if (typeof call?.id === 'string') ids.push(call.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Structured compaction summary (deterministic, no model call)
// ---------------------------------------------------------------------------

function buildStructuredCompactionSummary(messages: AgentMessage[]): string {
  const sections = extractStructuredSections(messages);
  return formatStructuredSummary(sections, MAX_SUMMARY_CHARS);
}

function buildAggressiveSummary(messages: AgentMessage[]): string {
  const sections = extractStructuredSections(messages);
  return formatStructuredSummary(sections, 1200);
}

interface StructuredSections {
  task: string;
  files: string[];
  actions: string[];
  state: string[];
}

function extractStructuredSections(messages: AgentMessage[]): StructuredSections {
  const files = new Set<string>();
  const actions: string[] = [];
  const stateItems: string[] = [];
  let task = '';

  for (const message of messages) {
    if (message.role === 'user' && !task) {
      task = clipped(message.content.trim(), MAX_STRUCTURED_SECTION_CHARS);
    }

    if (message.role === 'tool') {
      const parsed = tryParseJson(message.content);
      if (parsed && typeof parsed === 'object') {
        const output = (parsed as { output?: unknown }).output;
        if (output && typeof output === 'object') {
          const path = (output as { path?: unknown }).path;
          if (typeof path === 'string') files.add(path);
        }
      }
    }

    if (message.role === 'assistant' && hasToolCalls(message)) {
      const toolNames = extractToolCallIds(message).length > 0 ? 'tool calls' : '';
      if (toolNames) {
        actions.push(`called tools (${extractToolCallIds(message).length} calls)`);
      }
    }

    if (message.role === 'assistant' && !hasToolCalls(message) && message.content.trim()) {
      const trimmed = message.content.replace(/\s+/g, ' ').trim();
      if (trimmed.length > 10) {
        stateItems.push(clipped(trimmed, 160));
      }
    }
  }

  if (!task && messages.length > 0) {
    const first = messages[0].content.trim();
    task = clipped(first, MAX_STRUCTURED_SECTION_CHARS);
  }

  return {
    task,
    files: [...files].slice(0, 20),
    actions: actions.slice(-10),
    state: stateItems.slice(-5),
  };
}

function formatStructuredSummary(sections: StructuredSections, maxChars: number): string {
  const lines: string[] = [];

  lines.push('TASK:');
  lines.push(sections.task ? `  ${sections.task}` : '  (not available)');
  lines.push('');

  lines.push('FILES:');
  if (sections.files.length > 0) {
    for (const file of sections.files) {
      lines.push(`  ${file}`);
    }
  } else {
    lines.push('  (none identified)');
  }
  lines.push('');

  lines.push('ACTIONS:');
  if (sections.actions.length > 0) {
    for (const action of sections.actions) {
      lines.push(`  - ${action}`);
    }
  } else {
    lines.push('  (none identified)');
  }
  lines.push('');

  lines.push('STATE:');
  if (sections.state.length > 0) {
    for (const item of sections.state) {
      lines.push(`  - ${item}`);
    }
  } else {
    lines.push('  (none identified)');
  }

  const full = lines.join('\n');
  if (full.length <= maxChars) return full;
  return `${full.slice(0, maxChars)}\n[summary truncated]`;
}

// ---------------------------------------------------------------------------
// Proactive model message assembly (compacts old tool results)
// ---------------------------------------------------------------------------

export interface AssemblyStats {
  totalMessagesIn: number;
  totalMessagesOut: number;
  estimatedTokensIn: number;
  estimatedTokensOut: number;
  compactedToolResults: number;
  keptRecentTurns: number;
  droppedDuplicateReadResults: number;
  /** File paths whose exact content was compacted out of the model-facing view. */
  compactedFilePaths: string[];
}

const DEFAULT_KEEP_RECENT_TOOL_TURNS = 3;

/**
 * Build the messages array that is actually sent to the model.
 *
 * This is the context-management bridge: it takes the canonical
 * conversation.messages history and produces a compacted view.
 *
 * Rules:
 * - System prompt and orientation are kept.
 * - The last N tool turns are kept verbatim (tool call + results).
 * - Older tool results are compacted to short structured summaries.
 * - All non-tool messages (user, assistant text) are kept verbatim.
 * - Tool-call/tool-result protocol validity is preserved.
 *
 * This runs proactively on every model call, not just when budget is exceeded.
 */
export function assembleModelMessages(
  messages: AgentMessage[],
  settings: ContextBudgetSettings,
  ledger?: InspectionLedger,
  readCounts?: Map<string, number>,
): { messages: AgentMessage[]; stats: AssemblyStats } {
  const keepTurns = settings.keepRecentToolTurns ?? DEFAULT_KEEP_RECENT_TOOL_TURNS;
  const stats: AssemblyStats = {
    totalMessagesIn: messages.length,
    totalMessagesOut: 0,
    estimatedTokensIn: estimateRequestTokens(messages),
    estimatedTokensOut: 0,
    compactedToolResults: 0,
    keptRecentTurns: 0,
    droppedDuplicateReadResults: 0,
    compactedFilePaths: [],
  };

  if (messages.length === 0) return { messages: [], stats };

  // 'none' and 'off' strategies: skip all tool result compaction
  if (settings.strategyMode === 'none' || settings.strategyMode === 'off') {
    stats.totalMessagesOut = messages.length;
    stats.estimatedTokensOut = stats.estimatedTokensIn;
    return { messages: [...messages], stats };
  }

  // For 'light' strategy: compute oversized threshold (25% of effective window)
  const shouldSkipOldResultCompaction = settings.strategyMode === 'light';
  const effectiveLimit = settings.contextWindowTokens - settings.reservedOutputTokens;
  const lightOversizedThreshold = Math.max(50, Math.floor(effectiveLimit * 0.25));

  // Step 1: Find recent tool turns (count from the end backward)
  const toolTurnIndices = findToolTurnIndices(messages);
  const recentTurnStartIndex =
    toolTurnIndices.length > keepTurns ? toolTurnIndices[toolTurnIndices.length - keepTurns] : -1;
  stats.keptRecentTurns = toolTurnIndices.length > keepTurns ? keepTurns : toolTurnIndices.length;

  // Step 2: Build output, compacting old tool results
  const result: AgentMessage[] = [];
  const keepAllToolResults = recentTurnStartIndex < 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'system' && i === 0) {
      // Keep system prompt
      result.push(msg);
      continue;
    }

    if (msg.role === 'tool') {
      if (keepAllToolResults || (i >= recentTurnStartIndex && recentTurnStartIndex >= 0)) {
        // Recent turn: keep verbatim unless the result is excessively large.
        // Large read/list/search/git results overflow context even in recent
        // turns. Compact them so the model retains path/range/truncation
        // awareness without the full content.
        const recentResultCap = Math.floor(settings.maxSingleReadResultTokens / 3);
        const msgTokens = estimateMessageTokens(msg);
        if (msgTokens > recentResultCap && recentResultCap > 0) {
          const compacted = compactToolResultMessage(msg, ledger, readCounts);
          if (compacted) {
            result.push(compacted);
            stats.compactedToolResults += 1;
            const filePath = extractFilePathFromToolMessage(msg);
            if (filePath) stats.compactedFilePaths.push(filePath);
            continue;
          }
        }
        result.push(msg);
      } else {
        // Old tool result
        if (shouldSkipOldResultCompaction) {
          // Light strategy: keep old results verbatim unless truly enormous (>25% of window)
          if (estimateMessageTokens(msg) > lightOversizedThreshold) {
            const compacted = compactToolResultMessage(msg, ledger, readCounts);
            if (compacted) {
              result.push(compacted);
              stats.compactedToolResults += 1;
              const filePath = extractFilePathFromToolMessage(msg);
              if (filePath) stats.compactedFilePaths.push(filePath);
              continue;
            }
          }
          result.push(msg);
        } else {
          // Aggressive/moderate/default: compact old tool results to structured summaries
          const compacted = compactToolResultMessage(msg, ledger, readCounts);
          if (compacted) {
            result.push(compacted);
            stats.compactedToolResults += 1;
            // Track which file paths are compacted out of model view
            const filePath = extractFilePathFromToolMessage(msg);
            if (filePath) stats.compactedFilePaths.push(filePath);
          } else {
            // If we can't compact (unparseable), keep original but flag
            result.push(msg);
          }
        }
      }
      continue;
    }

    // Non-tool messages: keep verbatim
    result.push(msg);
  }

  stats.totalMessagesOut = result.length;
  stats.estimatedTokensOut = estimateRequestTokens(result);

  return { messages: result, stats };
}

/**
 * Find the start indices of tool turns in the messages array.
 * A tool turn starts at an assistant message with tool_calls and ends
 * after its matching tool result messages.
 */
function findToolTurnIndices(messages: AgentMessage[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && hasToolCalls(msg)) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Compact a single tool result message into a short structured summary.
 * Returns null if the message cannot be parsed as JSON (kept verbatim).
 */
/**
 * Extract a repo-relative file path from a tool result message for compaction tracking.
 */
function extractFilePathFromToolMessage(msg: AgentMessage): string | undefined {
  const parsed = tryParseJson(msg.content);
  if (!parsed || typeof parsed !== 'object') return undefined;

  const toolResult = parsed as { toolName?: string; output?: unknown };
  const output = toolResult.output;
  if (!output || typeof output !== 'object') return undefined;

  const path = (output as Record<string, unknown>).path;
  if (typeof path === 'string' && path.trim().length > 0) return path.trim();

  // search_text results don't have a single path, but may have matches with paths
  const matches = (output as Record<string, unknown>).matches;
  if (Array.isArray(matches) && matches.length > 0) {
    const firstMatch = matches[0] as Record<string, unknown> | undefined;
    if (firstMatch && typeof firstMatch.path === 'string') return firstMatch.path;
  }

  return undefined;
}

function compactToolResultMessage(
  msg: AgentMessage,
  ledger?: InspectionLedger,
  readCounts?: Map<string, number>,
): AgentMessage | null {
  const parsed = tryParseJson(msg.content);
  if (!parsed || typeof parsed !== 'object') return null;

  const toolResult = parsed as { success?: boolean; toolName?: string; output?: unknown; error?: string };
  const summary = summarizeToolOutput(toolResult.toolName ?? 'unknown', toolResult.output, ledger, readCounts);
  const summaryContent = (summary?.contentSummary as string | undefined) ?? '';

  return {
    role: msg.role,
    tool_call_id: msg.tool_call_id,
    name: msg.name,
    content: JSON.stringify({
      success: toolResult.success,
      toolName: toolResult.toolName,
      error: toolResult.error,
      output: summary,
      _compacted: true,
      contentSummary: summaryContent
        ? `Previous ${toolResult.toolName} result was compacted. ${summaryContent}`
        : `Previous ${toolResult.toolName} result was compacted to save context space. The metadata is authoritative — re-run the tool for full output.`,
    }),
  };
}

function summarizeToolOutput(
  toolName: string,
  output: unknown,
  _ledger?: InspectionLedger,
  readCounts?: Map<string, number>,
): Record<string, unknown> {
  if (!output || typeof output !== 'object') {
    return { summary: String(output ?? '') };
  }

  const out = output as Record<string, unknown>;

  if (toolName === 'read' || toolName === 'read_file_range') {
    return summarizeReadOutput(out, readCounts);
  }

  if (toolName === 'list_files') {
    return summarizeListOutput(out);
  }

  if (toolName === 'search_text') {
    return summarizeSearchOutput(out);
  }

  if (toolName === 'show_git_status') {
    return summarizeGitStatusOutput(out);
  }

  if (toolName === 'show_git_diff') {
    return summarizeGitDiffOutput(out);
  }

  if (toolName === 'bash') {
    return summarizeBashOutput(out);
  }

  if (toolName === 'edit' || toolName === 'replace_in_file') {
    // Edit results are small (path + diff), keep compact
    return {
      path: out.path,
      diff: typeof out.diff === 'string' ? clipped(out.diff, 300) : undefined,
    };
  }

  if (toolName === 'write' || toolName === 'create_file') {
    return { path: out.path, bytes: out.bytes };
  }

  // Default: return compact representation
  return {
    path: out.path,
    truncated: out.truncated,
    omitted: out.omitted,
  };
}

function summarizeReadOutput(out: Record<string, unknown>, readCounts?: Map<string, number>): Record<string, unknown> {
  const path = typeof out.path === 'string' ? out.path : undefined;
  const totalLines = typeof out.totalLines === 'number' ? out.totalLines : undefined;
  const startLine = typeof out.startLine === 'number' ? out.startLine : undefined;
  const endLine = typeof out.endLine === 'number' ? out.endLine : undefined;
  const truncated = !!out.truncated;
  const omitted = !!out.omitted;
  const estimatedTokens = typeof out.estimatedOriginalTokens === 'number' ? out.estimatedOriginalTokens : undefined;

  const summary: Record<string, unknown> = {
    path,
    _compacted: true,
  };

  if (omitted) {
    summary.omitted = true;
    summary.reason = out.reason ?? 'budget';
    summary.contentSummary = `File read for "${path ?? 'unknown'}" was omitted (reason: ${summary.reason}).`;
    return summary;
  }

  if (startLine !== undefined && endLine !== undefined) {
    summary.lines = `${startLine}-${endLine}${totalLines !== undefined ? `/${totalLines}` : ''}`;
  } else if (totalLines !== undefined) {
    summary.totalLines = totalLines;
  }

  // Build natural language summary for the model
  if (path) {
    if (startLine !== undefined && endLine !== undefined) {
      const lineInfo =
        totalLines !== undefined ? `lines ${startLine}-${endLine} of ${totalLines}` : `lines ${startLine}-${endLine}`;
      summary.contentSummary = `File "${path}" ${lineInfo} were read earlier. Use the read tool to re-read if needed.`;
    } else if (totalLines !== undefined) {
      summary.contentSummary = `File "${path}" (${totalLines} lines total) was read earlier. Use the read tool to re-read if needed.`;
    } else {
      summary.contentSummary = `File "${path}" was read earlier. Use the read tool to re-read if needed.`;
    }
    if (truncated) {
      summary.contentSummary += ' (output was truncated).';
    }
  } else {
    summary.contentSummary = 'A file read was performed earlier (path unknown).';
  }

  if (estimatedTokens !== undefined) {
    summary.estimatedTokens = estimatedTokens;
  }

  if (truncated) {
    summary.truncated = true;
  }

  // Add repeated read info if available
  if (path && readCounts) {
    const count = readCounts.get(path);
    if (count && count > 1) summary.readCount = count;
  }

  return summary;
}

function summarizeListOutput(out: Record<string, unknown>): Record<string, unknown> {
  const path = typeof out.path === 'string' ? out.path : undefined;
  const files = Array.isArray(out.files) ? (out.files as string[]) : undefined;
  const entries = Array.isArray(out.entries) ? (out.entries as Array<{ name: string }>) : undefined;
  const truncated = !!out.truncated;

  const summary: Record<string, unknown> = {
    path,
    _compacted: true,
  };

  if (files) {
    summary.fileCount = files.length;
    summary.topFiles = files.slice(0, 20);
    summary.contentSummary = `Directory listing for "${path ?? 'unknown'}" — ${files.length} file(s).`;
  } else if (entries) {
    summary.entryCount = entries.length;
    summary.topEntries = entries.slice(0, 20).map((e) => e.name);
    summary.contentSummary = `Directory listing for "${path ?? 'unknown'}" — ${entries.length} entries.`;
  } else {
    summary.contentSummary = `Directory listing for "${path ?? 'unknown'}" was performed earlier.`;
  }

  if (truncated) {
    summary.truncated = true;
    summary.contentSummary += ' Results were truncated.';
  }

  return summary;
}

function summarizeSearchOutput(out: Record<string, unknown>): Record<string, unknown> {
  const query = typeof out.query === 'string' ? out.query : undefined;
  const matches = Array.isArray(out.matches) ? (out.matches as unknown[]) : undefined;
  const truncated = !!out.truncated;
  const matchCount = matches?.length ?? 0;

  const contentSummary = query
    ? `Searched for "${query}" — ${matchCount} match(es). Use read or search_text to fetch full content if needed.`
    : `Text search returned ${matchCount} match(es).`;

  return {
    query,
    matchCount,
    truncated,
    _compacted: true,
    contentSummary: truncated ? contentSummary + ' Results were truncated.' : contentSummary,
  };
}

function summarizeGitStatusOutput(out: Record<string, unknown>): Record<string, unknown> {
  const status = Array.isArray(out.status) ? (out.status as string[]) : undefined;
  const truncated = !!out.truncated;
  const lineCount = status?.length ?? 0;

  const contentSummary = `Git status had ${lineCount} change(s). Use read or bash to inspect details if needed.`;

  return {
    lineCount,
    truncated,
    _compacted: true,
    contentSummary: truncated ? contentSummary + ' (truncated).' : contentSummary,
  };
}

function summarizeGitDiffOutput(out: Record<string, unknown>): Record<string, unknown> {
  const diff = Array.isArray(out.diff) ? (out.diff as string[]) : undefined;
  const truncated = !!out.truncated;
  const lineCount = diff?.length ?? 0;

  const contentSummary = `Git diff was ${lineCount} line(s). Use bash (git diff) or read to inspect details if needed.`;

  return {
    lineCount,
    truncated,
    _compacted: true,
    contentSummary: truncated ? contentSummary + ' (truncated).' : contentSummary,
  };
}

function summarizeBashOutput(out: Record<string, unknown>): Record<string, unknown> {
  const command = typeof out.command === 'string' ? out.command : undefined;
  const stdout = typeof out.stdout === 'string' ? out.stdout : '';
  const stderr = typeof out.stderr === 'string' ? out.stderr : '';
  const exitCode = typeof out.exitCode === 'number' ? out.exitCode : undefined;
  const safetyWarnings = Array.isArray(out.safetyWarnings) ? out.safetyWarnings.filter(isString) : undefined;

  const totalBytes = Buffer.byteLength(stdout, 'utf-8') + Buffer.byteLength(stderr, 'utf-8');

  // Keep full output for small results so the model can inspect details.
  const FULL_OUTPUT_THRESHOLD = 2048;
  if (totalBytes <= FULL_OUTPUT_THRESHOLD) {
    return {
      command,
      exitCode,
      stdout: stdout.trim() || undefined,
      stderr: stderr.trim() || undefined,
      safetyWarnings,
    };
  }

  // Large outputs get a compact summary with previews.
  return {
    command,
    exitCode,
    stdoutBytes: Buffer.byteLength(stdout, 'utf-8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf-8'),
    stdoutPreview: clipped(stdout.trim(), 400) || undefined,
    stderrPreview: clipped(stderr.trim(), 300) || undefined,
    safetyWarnings,
    _compacted: true,
    _compactionReason: `output exceeds ${FULL_OUTPUT_THRESHOLD} bytes`,
    contentSummary: command
      ? `Bash command "${command}" exited with code ${exitCode ?? '?'} and produced ${totalBytes} byte(s) of output. Use bash to re-run if needed.`
      : `Bash command produced ${totalBytes} byte(s) of output.`,
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function clipped(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 14)}...[truncated]`;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

// ---------------------------------------------------------------------------
// Budget estimation for orchestration (spec 021 phase 1)
// ---------------------------------------------------------------------------

/**
 * Budget strategy derived from task size relative to context window.
 *
 * - inline: task fits well under 50% of context window → single agent
 * - orchestrate: task needs 50-90% → plan sub-tasks but might fit inline
 * - decompose: task exceeds 90% → mandatory decomposition into sub-agents
 */
export type BudgetStrategy = 'inline' | 'orchestrate' | 'decompose';

/**
 * Repository metadata collected for budget estimation.
 */
export interface RepoMetadata {
  /** Total number of files tracked in the repo (excluding node_modules, .git, etc.). */
  fileCount: number;
  /** Total size of all tracked files in KB. */
  totalKB: number;
  /** Total size of source files (extensions like .ts, .js, .py, etc.) in KB. */
  sourceKB: number;
}

/**
 * Component breakdown of a budget estimate.
 */
export interface BudgetBreakdown {
  /** Tokens needed for the task description itself. */
  taskTokens: number;
  /** Tokens needed for repo structure overhead (file listings, git metadata). */
  repoOverheadTokens: number;
  /** Tokens needed for system prompt and tool definitions. */
  systemOverheadTokens: number;
}

/**
 * Budget estimate produced by the estimation engine.
 */
export interface BudgetEstimate {
  /** Estimated tokens for the task + repo overhead + system overhead. */
  estimatedTokens: number;
  /** Classified strategy based on utilization. */
  strategy: BudgetStrategy;
  /** Safety margin in tokens (buffer between estimate and context window). */
  safetyMargin: number;
  /** Fraction of context window utilized (0-1). */
  utilization: number;
  /** Context window tokens used as the baseline. */
  contextWindowTokens: number;
  /** Breakdown of the estimate into components. */
  breakdown: BudgetBreakdown;
}

/**
 * Estimate the token budget for a task and determine the orchestration strategy.
 *
 * Integrates with the existing context budget framework:
 * - Uses resolveContextBudgetSettings() to get the per-model reserved tokens as baseline.
 * - Uses tokenCounter.estimate() when available, falls back to Math.ceil(text.length / 4).
 * - Classifies: < 50% window → inline, < 90% → orchestrate, ≥ 90% → decompose.
 *
 * @param params.task - The user's task description.
 * @param params.repoMetadata - File count and sizes for the repository.
 * @param params.contextWindow - Model's context window in tokens.
 * @param params.tokenCounter - Optional TokenCounter for more accurate estimation.
 * @returns A BudgetEstimate with strategy classification.
 */
export function estimateTaskBudget(params: {
  task: string;
  repoMetadata: RepoMetadata;
  contextWindow: number;
  tokenCounter?: TokenCounter;
}): BudgetEstimate {
  const { task, repoMetadata, contextWindow } = params;

  // Resolve default settings to get reserved output tokens as baseline
  const settings = resolveContextBudgetSettings({ contextWindowTokens: contextWindow });
  const effectiveWindow = contextWindow - settings.reservedOutputTokens;

  // Estimate task tokens
  const taskTokens = params.tokenCounter
    ? params.tokenCounter.countInput([{ role: 'user', content: task }])
    : Math.ceil(task.length / 4);

  // Estimate repo overhead: each file contributes ~60 tokens for path + metadata,
  // plus ~1 token per KB of source for file listing overhead.
  const repoOverheadTokens = Math.ceil(repoMetadata.fileCount * 60 + repoMetadata.sourceKB * 1);

  // System overhead: system prompt + tool definitions ≈ 2500 tokens (baseline)
  const systemOverheadTokens = 2500;

  const estimatedTokens = taskTokens + repoOverheadTokens + systemOverheadTokens;
  const utilization = effectiveWindow > 0 ? estimatedTokens / effectiveWindow : 1;
  const safetyMargin = Math.max(0, effectiveWindow - estimatedTokens);

  // Classify strategy based on utilization thresholds
  let strategy: BudgetStrategy;
  if (utilization < 0.5) {
    strategy = 'inline';
  } else if (utilization < 0.9) {
    strategy = 'orchestrate';
  } else {
    strategy = 'decompose';
  }

  return {
    estimatedTokens,
    strategy,
    safetyMargin,
    utilization: Math.min(utilization, 1),
    contextWindowTokens: contextWindow,
    breakdown: {
      taskTokens,
      repoOverheadTokens,
      systemOverheadTokens,
    },
  };
}
