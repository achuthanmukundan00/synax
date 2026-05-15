import type { AgentEvent, ToolEvent } from '../agent/events';
import type { RunStateSnapshot, TuiDebugHistoryItem, TuiSeverity } from '../agent/tui-state';

export type SemanticEventClass =
  | 'plan'
  | 'edit'
  | 'diff'
  | 'command'
  | 'tool_result'
  | 'review'
  | 'commit'
  | 'checkpoint'
  | 'approval'
  | 'status'
  | 'error'
  | 'note'
  | 'assistant_text';

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
    case 'assistant_message':
      return textEvent('assistant_text', base, 'Note', sanitizeAssistantText(event.content));
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
    case 'task_finished':
      return [
        semantic(event.status === 'completed' ? 'tool_result' : 'error', base, {
          type: 'tool_result',
          title: event.status === 'completed' ? 'Task complete' : 'Task stopped',
          summary: event.error ?? event.verification,
          status: event.status === 'completed' ? 'ok' : 'error',
        }),
      ];
    case 'error':
      return textEvent('error', base, 'Error', event.message);
    default:
      return [];
  }
}

export function semanticEventsFromDebugHistory(state: RunStateSnapshot): SemanticEvent[] {
  return state.debugHistory.flatMap((item, index) => semanticEventFromDebugItem(item, index, state));
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
  if (item.kind === 'user') return textEvent('note', base, 'Prompt', item.detail || item.summary, `history-${index}`);
  if (item.kind === 'model') {
    return textEvent(
      'assistant_text',
      base,
      'Note',
      sanitizeAssistantText(item.detail || item.summary),
      `history-${index}`,
    );
  }
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

function textEvent(
  eventClass: SemanticEventClass,
  base: Pick<SemanticEvent, 'timestamp' | 'metadata'>,
  title: string,
  body: string,
  explicitId?: string,
): SemanticEvent[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  return [semantic(eventClass, base, { type: 'text', title, body: summarizePlain(trimmed, 400) }, explicitId)];
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
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
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
