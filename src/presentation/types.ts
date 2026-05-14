/**
 * Canonical presentation model for Synax output.
 *
 * Every piece of user-visible output maps to exactly one PresentationBlock kind.
 * The TUI is the richest renderer; the CLI is a deterministic subset projection.
 * Both consume the same PresentationState.
 */

export interface SubAgentSummary {
  id: string;
  task: string;
  phase: 'pending' | 'active' | 'completed' | 'failed';
  changedFiles?: string[];
  error?: string;
}

export type PresentationBlock =
  /** Model output: final answer, thinking summary, or question to user */
  | {
      kind: 'model_output';
      role: 'primary' | 'note' | 'question';
      text: string;
    }
  /** Tool call or verification lifecycle */
  | {
      kind: 'tool_activity';
      toolName: string;
      phase: 'started' | 'completed' | 'failed';
      summary: string;
      detail?: string;
    }
  /** Local shell command with structured result */
  | {
      kind: 'shell_command';
      command: string;
      exitCode: number;
      durationMs: number;
      stdout?: string;
      stderr?: string;
    }
  /** Orchestration lifecycle with sub-agent summaries */
  | {
      kind: 'orchestration';
      mode: 'handoff' | 'sequential' | 'parallel';
      phase: 'planning' | 'active' | 'completed' | 'failed';
      summary: string;
      subAgents: SubAgentSummary[];
    }
  /** Runtime telemetry (model info, tokens, cost, errors) */
  | {
      kind: 'runtime_status';
      label: string;
      value: string;
      priority: 'line' | 'detail';
    }
  /** Debug/internal detail (patch previews, raw tool output, compaction) */
  | {
      kind: 'debug_detail';
      tag: string;
      text: string;
    };

/** Memory decision provenance tracked per-memory-retrieval. */
export interface MemoryDecision {
  /** Human-readable label for the memory (e.g., "project:synax/tui-symbols"). */
  label: string;
  /** How the memory was handled: used, ignored, rejected, or quarantined. */
  disposition: 'used' | 'ignored' | 'rejected' | 'quarantined';
  /** Optional reason for the disposition. */
  reason?: string;
  /** Optional provenance info (e.g., "session-abc / 2h ago"). */
  provenance?: string;
  /** Whether this memory conflicts with live tool/session state. */
  conflict?: boolean;
  /** Whether the memory was marked stale (e.g., stale cwd). */
  stale?: boolean;
}

/** Handoff packet summary for the presentation layer. */
export interface HandoffPacketView {
  /** Source model/agent identifier. */
  source: string;
  /** Target model/agent identifier. */
  target: string;
  /** Reason for the handoff. */
  reason: string;
  /** Summary of the packet content. */
  summary: string;
  /** Context keys included in the handoff. */
  includedContext: string[];
  /** Context keys excluded from the handoff. */
  excludedContext: string[];
}

export interface PresentationState {
  /** Flat, ordered timeline of blocks emitted so far. Append-only except
   *  orchestration blocks which are replaced in-place. */
  readonly blocks: readonly PresentationBlock[];
  /** Live text accumulated from assistant_delta streaming.
   *  Not yet committed as a model_output block. Reset on each
   *  assistant_message or model_step_started. */
  streamingText: string;
  /** Memory decisions accumulated from memory retrieval events. */
  memoryDecisions: MemoryDecision[];
  /** Handoff packets accumulated from handoff events. */
  handoffPackets: HandoffPacketView[];
  /** Agent panes for multi-agent / swarm views. */
  agentPanes: AgentPaneView[];
  /** Live repo state for staleness detection against memory. */
  liveRepoState: LiveRepoState;
}

/** Live git/session state for staleness detection. */
export interface LiveRepoState {
  cwd?: string;
  branch?: string;
  repo?: string;
}

/** Agent pane for multi-agent display. */
export interface AgentPaneView {
  id: string;
  role: string;
  model: string;
  phase: 'pending' | 'active' | 'completed' | 'failed';
  lastAction: string;
  finding?: string;
}

export function createInitialPresentationState(): PresentationState {
  return {
    blocks: [],
    streamingText: '',
    memoryDecisions: [],
    handoffPackets: [],
    agentPanes: [],
    liveRepoState: { cwd: undefined, branch: undefined, repo: undefined },
  };
}
