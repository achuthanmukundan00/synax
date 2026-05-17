/**
 * SynaxRuntime — single-agent embeddable runtime for external apps.
 *
 * Wraps the internal Session orchestrator with a clean public interface.
 * No subagents, handoff, orchestration, or child sessions exposed.
 *
 * ```ts
 * const runtime = new SynaxRuntime({ model: { baseUrl: '...', model: '...' } });
 * const result = await runtime.run({ input: 'Do something' });
 * console.log(result.output);
 * ```
 */

import { createLLMClient, type ProviderFactoryInput } from '../llm/provider-factory';
import { Session } from '../session/Session';
import { createToolRegistry } from '../tools/registry';
import { eventNow } from '../agent/events';
import type { AgentClient } from '../session/types';
import type { AgentEvent, ToolEvent } from '../agent/events';
import type { PatchPreview } from '../agent/patch';
import type { ToolDefinition, ToolRegistry } from '../tools/types';
import type { HolographicMemory, MemoryEntry, MemorySearchResult, HandoffManifest } from '../memory/HolographicMemory';
import type { ContextBudgetSettings } from '../agent/context-budget';
import type { Logger } from '../logging';
import type { RunMode } from '../agent/task-policy';
import type { MemoryAdapter, RuntimeConfig, RuntimeEvent, RuntimeResult, RuntimeRunInput } from './types';

// ─── Memory Bridge ─────────────────────────────────────────
// Wraps an external MemoryAdapter to satisfy Session's HolographicMemory-shaped
// expectation without changing Session's type or internals.

class MemoryBridge {
  private adapter: MemoryAdapter;
  storeErrorCount = 0;
  searchErrorCount = 0;
  indexErrorCount = 0;

  constructor(adapter: MemoryAdapter) {
    this.adapter = adapter;
  }

  get isAvailable(): boolean {
    return this.storeErrorCount < 5 && this.searchErrorCount < 5 && this.indexErrorCount < 5;
  }

  /** Fire-and-forget store. Handles both sync throws and async rejections. */
  store(entry: MemoryEntry): void {
    try {
      const result = this.adapter.store(entry);
      if (result instanceof Promise) {
        result.catch(() => {
          this.storeErrorCount++;
        });
      }
    } catch {
      this.storeErrorCount++;
    }
  }

  /** Search. Awaits async adapters. */
  async search(query: string, limit?: number): Promise<MemorySearchResult[]> {
    try {
      const results = this.adapter.search(query, limit);
      return await results;
    } catch {
      this.searchErrorCount++;
      return [];
    }
  }

  /** Build memory index string. Awaits async adapters. */
  async buildMemoryIndex(): Promise<string | null> {
    try {
      const index = this.adapter.buildMemoryIndex();
      return await index;
    } catch {
      this.indexErrorCount++;
      return null;
    }
  }

  handoff(): HandoffManifest {
    return {
      sessionId: '',
      keyFindings: [],
      filesTouched: [],
      suggestedSearchTerms: [],
      turnCount: 0,
      entryCount: 0,
      domainTags: [],
    };
  }

  searchWithSnippets(): Array<MemorySearchResult & { snippet: string }> {
    return [];
  }

  getSuggestedSearchTerms(): string[] {
    return [];
  }
}

// ─── State mapping ─────────────────────────────────────────

function mapTerminalState(state: string): RuntimeResult['status'] {
  if (state === 'completed') return 'completed';
  if (state === 'blocked') return 'blocked';
  if (state === 'policy_blocked') return 'policy_blocked';
  return 'error';
}

// ─── SynaxRuntime ──────────────────────────────────────────

/**
 * @public
 */
export class SynaxRuntime {
  private client: AgentClient;
  private memory: MemoryAdapter | null;
  private tools: ToolDefinition[];
  private policy?: RuntimeConfig['policy'];
  private mode: RunMode;
  private onEvent?: RuntimeConfig['onEvent'];
  private onBudget?: RuntimeConfig['onBudget'];
  private onActivity?: RuntimeConfig['onActivity'];
  private workingDir: string;
  private registry: ToolRegistry;
  private sessionId?: string;
  private bashEnabled: boolean;
  private contextBudget?: Partial<ContextBudgetSettings>;
  private maxOutputTokens?: number;
  private logger?: Logger;
  private memoryBridge: MemoryBridge | null = null;

  constructor(config: RuntimeConfig) {
    if (config.client) {
      this.client = config.client;
    } else if (config.model) {
      const input: ProviderFactoryInput = {
        provider: config.model.provider === 'openai-compatible' ? 'custom' : config.model.provider || 'custom',
        baseUrl: config.model.baseUrl,
        model: config.model.model,
        apiKey: config.model.apiKey,
        maxOutputTokens: config.model.maxTokens,
        timeoutMs: config.model.timeoutMs ?? 120000,
        customHeaders: config.model.customHeaders,
      };
      const result = createLLMClient(input);
      this.client = result.client;
    } else {
      throw new Error('SynaxRuntime: either "model" or "client" config is required');
    }

    this.memory = config.memory ?? null;
    this.tools = config.tools ?? [];
    this.policy = config.policy;
    this.mode = config.mode ?? 'patch';
    this.onEvent = config.onEvent;
    this.onBudget = config.onBudget;
    this.onActivity = config.onActivity;
    this.workingDir = config.workingDir ?? process.cwd();
    this.sessionId = config.sessionId;
    this.bashEnabled = config.bashEnabled ?? true;
    this.contextBudget = config.contextBudget;
    this.maxOutputTokens = config.maxOutputTokens;
    this.logger = config.logger;
    this.registry = createToolRegistry({ repoRoot: this.workingDir });
    this.memoryBridge = this.memory ? new MemoryBridge(this.memory) : null;

    for (const tool of this.tools) {
      this.registry.register(tool);
    }
  }

  /**
   * Execute a single agent task.
   *
   * The agent runs a model ↔ tool loop until completion, error, or budget
   * exhaustion. Returns a clean RuntimeResult that does not expose internal
   * conversation state.
   */
  async run(input: RuntimeRunInput): Promise<RuntimeResult> {
    const task = input.context ? `${input.context}\n\n${input.input}` : input.input;

    const emit = (event: RuntimeEvent): void => {
      this.onEvent?.(event);
    };

    emit({ type: 'started', timestamp: eventNow() });

    // Use pre-built memory bridge so getMemoryStatus() can inspect its state
    const wrappedMemory: HolographicMemory | null = this.memoryBridge
      ? (this.memoryBridge as unknown as HolographicMemory)
      : null;

    const session = new Session({
      repoRoot: this.workingDir,
      client: this.client,
      sessionId: input.sessionId ?? this.sessionId,
      mode: this.mode,
      bashEnabled: this.bashEnabled,
      memory: wrappedMemory,
      registry: this.registry,
      maxToolCalls: 192,
      maxModelSteps: 64,
      contextBudget: this.contextBudget,
      abortSignal: input.signal,
      maxOutputTokens: this.maxOutputTokens,
      logger: this.logger,
      onBudget: this.onBudget,
      onActivity: this.onActivity,
      onEvent: (agentEvent: AgentEvent) => {
        this.forwardAgentEvent(agentEvent, emit);
      },
      approvePatch: async (preview: PatchPreview) => {
        if (this.policy?.approveFileEdit) {
          const decision = await this.policy.approveFileEdit(preview);
          return decision === 'allow' ? 'accept' : 'reject';
        }
        return 'accept';
      },
    });

    // Wire pre_tool_use control hook for policy
    if (this.policy?.approveToolUse) {
      session.eventBus.onControl('pre_tool_use', async (event) => {
        // `event` is PreToolUseEvent (narrowed by 'pre_tool_use' string literal)
        type PreToolUse = { toolName: string; arguments: Record<string, unknown> };
        const { toolName, arguments: args } = event as unknown as PreToolUse;
        const decision = await this.policy!.approveToolUse!({ toolName, args });
        if (decision === 'deny') {
          return { allow: false, reason: 'blocked by policy' };
        }
        return { allow: true };
      });
    }

    emit({ type: 'model_step', content: task, timestamp: eventNow() });

    let turnResult;
    try {
      turnResult = await session.startTurnWithRecovery(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', message, timestamp: eventNow() });
      return { status: 'error', output: '', filesChanged: [], toolCalls: 0, steps: 0, error: message };
    }

    const status = mapTerminalState(turnResult.terminalState);
    emit({ type: 'complete', status, timestamp: eventNow() });

    return {
      status,
      output: turnResult.finalAnswer,
      filesChanged: turnResult.changedFiles,
      toolCalls: turnResult.toolCalls.length,
      steps: turnResult.steps,
      error: turnResult.error,
    };
  }

  /**
   * Check the health of the internal MemoryBridge.
   * Returns null when no memory adapter is configured.
   */
  getMemoryStatus(): { available: boolean; storeErrors: number; searchErrors: number; indexErrors: number } | null {
    if (!this.memoryBridge) return null;
    return {
      available: this.memoryBridge.isAvailable,
      storeErrors: this.memoryBridge.storeErrorCount,
      searchErrors: this.memoryBridge.searchErrorCount,
      indexErrors: this.memoryBridge.indexErrorCount,
    };
  }

  private forwardAgentEvent(event: AgentEvent, emit: (e: RuntimeEvent) => void): void {
    switch (event.type) {
      case 'tool_started': {
        const te = event as ToolEvent;
        emit({
          type: 'tool_start',
          toolName: te.toolName,
          args: { summary: te.summary },
          timestamp: te.timestamp,
        });
        break;
      }
      case 'tool_finished': {
        const te = event as ToolEvent;
        emit({
          type: 'tool_finish',
          toolName: te.toolName,
          success: te.status === 'ok',
          error: te.status === 'error' ? te.summary : undefined,
          timestamp: te.timestamp,
        });
        break;
      }
      case 'error':
        emit({
          type: 'error',
          message: (event as { message: string }).message,
          timestamp: event.timestamp,
        });
        break;
      case 'assistant_message':
        emit({
          type: 'model_response',
          content: (event as { content: string }).content,
          timestamp: event.timestamp,
        });
        break;
      case 'model_step_started':
        emit({
          type: 'model_step_started',
          stepIndex: event.stepIndex ?? 0,
          timestamp: event.timestamp,
        });
        break;
      case 'task_started':
        emit({
          type: 'task_started',
          timestamp: event.timestamp,
        });
        break;
      case 'task_finished':
        emit({
          type: 'task_finished',
          timestamp: event.timestamp,
        });
        break;
      case 'token_usage': {
        const tu = event as {
          type: 'token_usage';
          inputTokens: number;
          outputTokens: number;
          stepIndex?: number;
          timestamp: string;
        };
        emit({
          type: 'token_usage',
          inputTokens: tu.inputTokens,
          outputTokens: tu.outputTokens,
          totalTokens: tu.inputTokens + tu.outputTokens,
          step: tu.stepIndex ?? 0,
          timestamp: tu.timestamp,
        });
        break;
      }
      default:
        break;
    }
  }
}
