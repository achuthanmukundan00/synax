import type { AgentEvent, ToolEvent } from '../agent/events';
import type { RunStateSnapshot, TuiDebugHistoryItem, TuiSeverity } from '../agent/tui-state';
import type { SessionEvent } from '../sessions/session-store';

export type SemanticEventClass =
  | 'plan'
  | 'edit'
  | 'diff'
  | 'command'
  | 'tool_result'
  | 'result_error'
  | 'review'
  | 'commit'
  | 'checkpoint'
  | 'approval'
  | 'status'
  | 'error'
  | 'prompt'
  | 'note'
  | 'assistant_text'
  | 'dispatch'
  | 'agent_status'
  | 'thinking';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface PlanPayload {
  type: 'plan';
  title: string;
  steps: string[];
  estimatedFiles?: number;
  estimatedCommands?: number;
}

export interface EditPayload {
  type: 'edit';
  file: string;
  linesAdded: number;
  linesModified: number;
  linesRemoved: number;
  summary: string;
  diffId?: string;
}

export interface DiffPayload {
  type: 'diff';
  file: string;
  hunks: string[];
  accepted?: boolean;
}

export interface CommandPayload {
  type: 'command';
  command: string;
  cwd: string;
  riskLevel: RiskLevel;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface ToolResultPayload {
  type: 'tool_result';
  title: string;
  summary: string;
  output?: string;
  status?: 'ok' | 'error';
}

export interface ApprovalPayload {
  type: 'approval';
  action: string;
  details: string;
  riskLevel: RiskLevel;
  choices: string[];
}

export interface CommitPayload {
  type: 'commit';
  message: string;
  files: string[];
  hash?: string;
}

export interface CheckpointPayload {
  type: 'checkpoint';
  title: string;
  files: string[];
  hash?: string;
}

export interface StatusPayload {
  type: 'status';
  label: string;
  detail?: string;
}

export interface TextPayload {
  type: 'text';
  title: string;
  body: string;
}

export type ArtifactPayload =
  | PlanPayload
  | EditPayload
  | DiffPayload
  | CommandPayload
  | ToolResultPayload
  | ApprovalPayload
  | CommitPayload
  | CheckpointPayload
  | StatusPayload
  | TextPayload;

export interface SemanticEvent {
  id: string;
  class: SemanticEventClass;
  timestamp: number;
  parentId?: string;
  artifact: ArtifactPayload;
  metadata: {
    model?: string;
    cost?: number;
    duration?: number;
    filesTouched?: string[];
    toolName?: string;
    riskLevel?: RiskLevel;
    toolCalls?: number;
  };
}

let nextEventSequence = 0;

export function classifyAgentEvent(event: AgentEvent, state: RunStateSnapshot, nowMs: number): SemanticEvent[] {
  const base = {
    timestamp: Date.parse(event.timestamp) || nowMs,
    metadata: {
      model: state.modelId || undefined,
      filesTouched: state.filesChangedThisRun.length > 0 ? state.filesChangedThisRun : undefined,
    },
  };

  switch (event.type) {
    case 'task_started':
      return [
        semantic('plan', base, {
          type: 'plan',
          title: event.task.trim() || 'New task',
          steps: ['Inspect relevant files', 'Apply focused changes', 'Run targeted verification'],
        }),
      ];
    case 'model_step_started':
      return [
        semantic('status', base, {
          type: 'status',
          label: 'Thinking',
          detail: event.stepIndex === undefined ? undefined : `step ${event.stepIndex}`,
        }),
      ];
    case 'user_message':
      return textEvent('prompt', base, 'Prompt', event.content);
    case 'assistant_message':
      return textEvent('tool_result', base, 'Result', sanitizeAssistantText(event.content));
    case 'command_output':
      return [
        semantic('command', base, {
          type: 'command',
          command: event.command,
          cwd: process.cwd(),
          riskLevel: riskFromCommand(event.command),
          stdout: event.content,
        }),
      ];
    case 'local_shell_command':
      return [
        semantic(
          event.command.trim().startsWith('git commit') ? 'commit' : 'command',
          {
            ...base,
            metadata: {
              ...base.metadata,
              duration: event.durationMs,
              riskLevel: riskFromCommand(event.command),
            },
          },
          event.command.trim().startsWith('git commit')
            ? {
                type: 'commit',
                message: extractCommitMessage(event.command) ?? event.command,
                files: state.filesChangedThisRun,
              }
            : {
                type: 'command',
                command: event.command,
                cwd: process.cwd(),
                riskLevel: riskFromCommand(event.command),
                stdout: event.stdout,
                stderr: event.stderr,
                exitCode: event.exitCode,
              },
        ),
      ];
    case 'tool_started':
      return [
        semantic(
          'command',
          { ...base, metadata: { ...base.metadata, toolName: event.toolName } },
          {
            type: 'command',
            command: toolCommandLabel(event.toolName, event.summary),
            cwd: process.cwd(),
            riskLevel: riskFromTool(event.toolName, event.summary),
          },
        ),
      ];
    case 'tool_finished': {
      const maybeEdit = editEventFromToolResult(event, base, state);
      if (maybeEdit) return [maybeEdit];
      return [
        semantic(
          event.status === 'error' ? 'error' : 'tool_result',
          { ...base, metadata: { ...base.metadata, toolName: event.toolName } },
          {
            type: 'tool_result',
            title: `${event.toolName} ${event.status === 'error' ? 'error' : 'ok'}`,
            summary: event.summary,
            output: event.detail,
            status: event.status,
          },
        ),
      ];
    }
    case 'patch_preview':
      return [
        semantic(
          'diff',
          { ...base, metadata: { ...base.metadata, toolName: event.toolName } },
          {
            type: 'diff',
            file: event.path,
            hunks: event.diff.split('\n').slice(0, 80),
          },
        ),
      ];
    case 'verification_started':
      return [
        semantic('command', base, {
          type: 'command',
          command: event.command ?? event.checkLabel,
          cwd: process.cwd(),
          riskLevel: 'low',
        }),
      ];
    case 'verification_passed':
    case 'verification_failed':
    case 'verification_skipped':
      return [
        semantic(event.type === 'verification_failed' ? 'error' : 'tool_result', base, {
          type: 'tool_result',
          title: event.checkLabel,
          summary: event.summary ?? event.type.replace('verification_', ''),
          status: event.type === 'verification_failed' ? 'error' : 'ok',
        }),
      ];
    case 'task_finished': {
      // Build a summary that includes file change information so the final
      // card shows subagent work even when the LLM's inline summary says "none".
      const fileInfo = event.changedFiles.length > 0 ? `\nFiles changed: ${event.changedFiles.length}` : '';
      const treeInfo =
        event.workingTreeClean !== undefined ? `\nWorking tree: ${event.workingTreeClean ? 'clean' : 'dirty'}` : '';
      const detail = terminalSummary(event.error ?? event.verification);
      const body = detail ? `${detail}${fileInfo}${treeInfo}` : `Status: ${event.status}${fileInfo}${treeInfo}`;
      if (!body.trim()) return [];
      return textEvent(event.status === 'completed' ? 'tool_result' : 'result_error', base, 'Result', body);
    }
    case 'error':
      return textEvent('error', base, 'Error', event.message);
    case 'orchestration_plan_generated': {
      // The verbose plan card (with mission text and task descriptions) is no
      // longer shown in the transcript. The compact dispatch_started card and
      // worker-running lifecycle cards replace it. The plan data is still
      // available in internal telemetry and EventStore.
      return [];
    }
    case 'dispatch_started': {
      const payload = event as import('../agent/events').DispatchStartedEvent;
      const bodyParts: string[] = [];
      const title = formatDispatchTitle(payload.mode as string, payload.agentCount, payload.strategy);
      return [
        semantic('dispatch', base, {
          type: 'text',
          title,
          body: bodyParts.join('\n'),
        }),
      ];
    }
    case 'child_session_spawned': {
      const spawnName = event.subtaskId ?? event.childSessionId ?? 'sub-agent';
      return [
        semantic('agent_status', base, {
          type: 'text',
          title: spawnName,
          body: 'running',
        }),
      ];
    }
    case 'child_session_completed': {
      const completedName = event.subtaskId ?? event.childSessionId ?? 'sub-agent';
      const result = event.result;
      const output = result.finalAnswer ?? '(no output)';
      const toolCalls = result.toolCalls ?? 0;
      const files = result.changedFiles ?? [];
      return [
        semantic(
          'agent_status',
          {
            ...base,
            metadata: {
              ...base.metadata,
              toolCalls,
              filesTouched: files.length > 0 ? files : base.metadata.filesTouched,
            },
          },
          {
            type: 'text',
            title: `${completedName} returned`,
            body: output,
          },
        ),
      ];
    }
    case 'child_session_failed': {
      const failedName = event.subtaskId ?? event.childSessionId ?? 'sub-agent';
      return [
        semantic('agent_status', base, {
          type: 'text',
          title: failedName,
          body: `Failed: ${event.error}`,
        }),
      ];
    }
    default:
      return [];
  }
}

export function semanticEventsFromDebugHistory(state: RunStateSnapshot): SemanticEvent[] {
  return state.debugHistory.flatMap((item, index) => semanticEventFromDebugItem(item, index, state));
}

/**
 * Rebuild transcript cards from a persisted session's append-only event log
 * so a resumed session shows its full prior conversation — prompts, model
 * results, and tool calls — in original order.
 */
export function semanticEventsFromSessionEvents(sessionEvents: SessionEvent[], modelId?: string): SemanticEvent[] {
  return sessionEvents.flatMap((event, index) => {
    const base = {
      timestamp: Date.parse(event.at) || Date.now(),
      metadata: { model: modelId || undefined },
    };
    const id = `resumed-${index}`;
    switch (event.type) {
      case 'user_message':
        return textEvent('prompt', base, 'Prompt', event.content ?? '', id);
      case 'assistant_message':
        return textEvent('tool_result', base, 'Result', sanitizeAssistantText(event.content ?? ''), id);
      case 'tool_call': {
        const toolName = event.name ?? 'tool';
        const detail = event.args === undefined ? '' : JSON.stringify(event.args);
        return [
          semantic(
            'command',
            { ...base, metadata: { ...base.metadata, toolName } },
            {
              type: 'command',
              command: toolCommandLabel(toolName, detail),
              cwd: process.cwd(),
              riskLevel: riskFromTool(toolName, detail),
            },
            id,
          ),
        ];
      }
      case 'summary':
        return textEvent('note', base, 'Session summary', event.content ?? '', id);
      // tool_result payloads are unbounded and already reflected in the
      // assistant messages; state_snapshot is internal.
      case 'tool_result':
      case 'state_snapshot':
      default:
        return [];
    }
  });
}

function semanticEventFromDebugItem(
  item: TuiDebugHistoryItem,
  index: number,
  state: RunStateSnapshot,
): SemanticEvent[] {
  const base = {
    timestamp: item.atMs,
    metadata: {
      model: state.modelId || undefined,
      filesTouched: state.filesChangedThisRun.length > 0 ? state.filesChangedThisRun : undefined,
    },
  };
  if (item.kind === 'user') return textEvent('prompt', base, 'Prompt', item.detail || item.summary, `history-${index}`);
  if (item.kind === 'model')
    return textEvent(
      'tool_result',
      base,
      'Result',
      sanitizeAssistantText(item.detail || item.summary),
      `history-${index}`,
    );
  if (item.kind === 'command' || item.kind === 'local_command') {
    return [
      semantic(
        'command',
        base,
        {
          type: 'command',
          command: item.summary,
          cwd: process.cwd(),
          riskLevel: riskFromCommand(item.summary),
          stdout: item.detail,
          exitCode: extractExitCode(item.detail),
        },
        `history-${index}`,
      ),
    ];
  }
  if (item.kind === 'tool_call') {
    const [toolName = 'tool', ...detail] = item.detail.split('\n');
    return [
      semantic(
        'command',
        { ...base, metadata: { ...base.metadata, toolName } },
        {
          type: 'command',
          command: toolCommandLabel(toolName, detail.join('\n')),
          cwd: process.cwd(),
          riskLevel: riskFromTool(toolName, detail.join('\n')),
        },
        `history-${index}`,
      ),
    ];
  }
  if (item.kind === 'tool_result') {
    return [
      semantic(
        /error/i.test(item.summary) ? 'error' : 'tool_result',
        base,
        {
          type: 'tool_result',
          title: item.summary,
          summary: summarizePlain(item.detail || item.summary),
          output: item.detail,
          status: /error/i.test(item.summary) ? 'error' : 'ok',
        },
        `history-${index}`,
      ),
    ];
  }
  if (item.kind === 'final_summary') {
    return textEvent('tool_result', base, 'Result', item.detail || item.summary, `history-${index}`);
  }
  return [];
}

function semantic(
  eventClass: SemanticEventClass,
  base: Pick<SemanticEvent, 'timestamp' | 'metadata'>,
  artifact: ArtifactPayload,
  explicitId?: string,
): SemanticEvent {
  return {
    id: explicitId ?? `semantic-${nextEventSequence++}`,
    class: eventClass,
    timestamp: base.timestamp,
    artifact,
    metadata: {
      ...base.metadata,
      riskLevel: 'riskLevel' in artifact ? artifact.riskLevel : base.metadata.riskLevel,
    },
  };
}

/** Maximum characters for a non-result text event body (error, prompt, note).
 *  Final assistant/model results (tool_result, result_error) are NOT truncated
 *  here — the TUI card renderer handles viewport culling separately. */
const NON_RESULT_TEXT_MAX = 2000;

/** Result text events (tool_result, result_error) are the final model answer.
 *  They must never be silently truncated. Pass the raw body through without
 *  line slicing or char caps; the TUI card renderer soft-wraps naturally. */
const RESULT_EVENT_CLASSES: ReadonlySet<SemanticEventClass> = new Set(['tool_result', 'result_error']);

function textEvent(
  eventClass: SemanticEventClass,
  base: Pick<SemanticEvent, 'timestamp' | 'metadata'>,
  title: string,
  body: string,
  explicitId?: string,
): SemanticEvent[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const isResult = RESULT_EVENT_CLASSES.has(eventClass);
  // Final results: pass raw body through — no summarization at all.
  // Non-results (error, prompt, note): safe summarization with generous cap.
  const artifactBody = isResult ? trimmed : summarizePlain(trimmed, NON_RESULT_TEXT_MAX);
  return [semantic(eventClass, base, { type: 'text', title, body: artifactBody }, explicitId)];
}

function editEventFromToolResult(
  event: ToolEvent,
  base: Pick<SemanticEvent, 'timestamp' | 'metadata'>,
  state: RunStateSnapshot,
): SemanticEvent | undefined {
  if (event.status !== 'ok') return undefined;
  const tool = event.toolName.toLowerCase();
  if (!['write', 'edit', 'replace_in_file'].includes(tool)) return undefined;
  const path = extractPath(event.detail ?? event.summary) ?? state.changes.items[state.changes.items.length - 1]?.path;
  if (!path) return undefined;
  return semantic(
    'edit',
    { ...base, metadata: { ...base.metadata, toolName: event.toolName } },
    {
      type: 'edit',
      file: path,
      linesAdded: 0,
      linesModified: 1,
      linesRemoved: 0,
      summary: summarizePlain(event.summary || `${event.toolName} applied`),
    },
  );
}

function toolCommandLabel(toolName: string, detail: string): string {
  const command = extractJsonStringValue(detail, 'command') ?? extractJsonStringValue(detail, 'cmd');
  if (command) return command;
  const path = extractJsonStringValue(detail, 'path') ?? extractJsonStringValue(detail, 'file');
  return path ? `${toolName} ${path}` : toolName;
}

function riskFromTool(toolName: string, detail: string): RiskLevel {
  const name = toolName.toLowerCase();
  const command = extractJsonStringValue(detail, 'command') ?? detail;
  if (name.includes('bash') || name.includes('shell')) return riskFromCommand(command);
  if (name.includes('write') || name.includes('edit') || name.includes('replace')) return 'medium';
  return 'low';
}

function riskFromCommand(command: string): RiskLevel {
  const text = command.toLowerCase();
  if (/\b(rm|chmod|chown|dd|mkfs|diskutil|sudo)\b/.test(text)) return 'high';
  if (/migrate|deploy|install|npm\s+i\b|pnpm\s+add|yarn\s+add|curl|wget/.test(text)) return 'high';
  if (/test|build|lint|typecheck|git\s+commit/.test(text)) return 'medium';
  return 'low';
}

function extractCommitMessage(command: string): string | undefined {
  return /(?:-m|--message)\s+["']([^"']+)["']/.exec(command)?.[1];
}

function extractExitCode(text: string): number | undefined {
  const match = /exit(?:\s+code|Code)?:\s*(-?\d+)/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

function extractPath(text: string): string | undefined {
  return (
    extractJsonStringValue(text, 'path') ??
    extractJsonStringValue(text, 'file') ??
    extractJsonStringValue(text, 'target_file')
  );
}

function extractJsonStringValue(text: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escapedKey}"\\s*:\\s*"([^"]+)"`).exec(text);
  return match?.[1];
}

function sanitizeAssistantText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
    .replace(/<\/?think(?:ing)?\b[^>]*>/gi, ' ')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ')
    .replace(/<\/?tool_call\b[^>]*>/gi, ' ')
    .replace(/<function=[^>]*>[\s\S]*?<\/function>/gi, ' ')
    .replace(/<\/?function\b[^>]*>/gi, ' ')
    .replace(/<parameter=[^>]*>[\s\S]*?<\/parameter>/gi, ' ')
    .replace(/<\/?parameter\b[^>]*>/gi, ' ')
    .replace(/<\/?invoke\b[^>]*>/gi, ' ')
    .replace(/=\w+=\w+\s+\S+?(?=\s|$|=\w+=)/gi, ' ')
    .replace(/\b(?:function|parameter)=\w+/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function terminalSummary(text: string | undefined): string {
  const clean = (text ?? '').trim();
  if (!clean || clean.toLowerCase() === 'not run') return '';
  return clean;
}

function summarizePlain(text: string, maxLength = 180): string {
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, 8)
    .join('\n');
  return clean.length > maxLength ? `${clean.slice(0, Math.max(0, maxLength - 1))}…` : clean;
}

export function riskFromSeverity(severity: TuiSeverity): RiskLevel {
  if (severity === 'S3') return 'high';
  if (severity === 'S1' || severity === 'S2') return 'medium';
  return 'low';
}

export function noteEvent(eventClass: SemanticEventClass, body: string): SemanticEvent {
  return semantic(
    eventClass,
    { timestamp: Date.now(), metadata: {} },
    { type: 'text', title: eventClass === 'error' ? 'Error' : 'Note', body },
  );
}

export function createCheckpointEvent(title: string, files: string[], hash: string): SemanticEvent {
  return semantic(
    'checkpoint',
    { timestamp: Date.now(), metadata: { filesTouched: files } },
    { type: 'checkpoint', title, files, hash },
  );
}

export function shouldEmitCheckpoint(currentFiles: number, lastFiles: number): boolean {
  const delta = currentFiles - lastFiles;
  return delta > 0 && delta % 5 === 0;
}

/**
 * Format the dispatch header title, with guard against "1 agents · parallel".
 *
 * Renders:
 * - "Strategy · repo reconnaissance (4 domains)"
 * - "Dispatch · 4 agents · parallel"
 * - "Delegated · 1 agent"
 * - "Inline · no delegation"
 */
export function formatDispatchTitle(mode: string, agentCount: number, strategy: string): string {
  // Guard: inline or 0 agents
  if (agentCount === 0 || mode === 'inline') {
    return 'Inline · no delegation';
  }

  // Guard: 1 agent in parallel mode → delegated single
  if (agentCount === 1 && mode === 'parallel') {
    return 'Delegated · 1 agent';
  }

  // Guard: 1 agent in any mode
  if (agentCount === 1) {
    return 'Delegated · 1 agent';
  }

  // Repo reconnaissance
  if (strategy === 'repo_reconnaissance' || strategy.startsWith('repo_recon')) {
    return `Strategy · repo reconnaissance (${agentCount} domains)`;
  }

  // Parallel / sequential
  if (mode === 'parallel') {
    return `Dispatch · ${agentCount} agents · parallel`;
  }
  if (mode === 'sequential') {
    return `Sequential plan · ${agentCount} steps`;
  }

  // Fallback
  return `Dispatch · ${agentCount} agents`;
}
