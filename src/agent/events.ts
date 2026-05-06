import { type PatchPreview } from './patch';

export type TerminalState =
  | 'completed'
  | 'blocked'
  | 'failed_verification'
  | 'budget_exhausted'
  | 'user_input_required'
  | 'model_error'
  | 'tool_error';

export interface AgentEventBase {
  type: string;
  timestamp: string;
  taskId?: string;
  stepIndex?: number;
}

export interface ToolEvent extends AgentEventBase {
  type: 'tool_started' | 'tool_finished';
  toolCallId: string;
  toolName: string;
  summary: string;
  detail?: string;
  status?: 'ok' | 'error';
}

export interface VerificationLifecycleEvent extends AgentEventBase {
  type:
    | 'verification_planned'
    | 'verification_started'
    | 'verification_passed'
    | 'verification_failed'
    | 'verification_skipped';
  checkId: string;
  checkLabel: string;
  command?: string;
  summary?: string;
  severity?: 'S0' | 'S1' | 'S2' | 'S3';
  durationMs?: number;
}

export type AgentEvent =
  | (AgentEventBase & {
      type: 'task_started';
      mode: 'read-only' | 'patch' | 'verify' | 'docs' | 'interactive';
      profile: string;
      endpoint: string;
      model: string;
      providerName?: string;
      contextBudgetTokens: number;
      contextWindowTokens?: number;
      maxModelSteps: number;
      maxToolCalls: number;
      tools: string[];
      task: string;
    })
  | (AgentEventBase & { type: 'model_step_started' })
  | (AgentEventBase & {
      type: 'context_budget_updated';
      estimatedInputTokens: number;
      inputLimit: number;
      contextWindowTokens: number;
      reservedOutputTokens: number;
      step: number;
    })
  | ToolEvent
  | VerificationLifecycleEvent
  | (AgentEventBase &
      PatchPreview & {
        type: 'patch_preview';
        toolCallId: string;
        toolName: string;
      })
  | (AgentEventBase & { type: 'assistant_message'; content: string })
  | (AgentEventBase & {
      type: 'task_finished';
      status: TerminalState;
      toolCalls: number;
      maxToolCalls: number;
      modelSteps: number;
      maxModelSteps: number;
      changedFiles: string[];
      workingTreeClean?: boolean;
      verification: string;
      error?: string;
    })
  | (AgentEventBase & { type: 'error'; message: string });

export function eventNow(): string {
  return new Date().toISOString();
}
