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
  status?: 'ok' | 'error';
}

export type AgentEvent =
  | (AgentEventBase & {
      type: 'task_started';
      mode: 'bounded' | 'interactive';
      profile: string;
      endpoint: string;
      model: string;
      contextBudgetTokens: number;
      maxModelSteps: number;
      maxToolCalls: number;
      tools: string[];
      task: string;
    })
  | (AgentEventBase & { type: 'model_step_started' })
  | ToolEvent
  | (AgentEventBase & { type: 'assistant_message'; content: string })
  | (AgentEventBase & {
      type: 'task_finished';
      status: TerminalState;
      toolCalls: number;
      maxToolCalls: number;
      modelSteps: number;
      maxModelSteps: number;
      changedFiles: string[];
      verification: string;
      error?: string;
    })
  | (AgentEventBase & { type: 'error'; message: string });

export function eventNow(): string {
  return new Date().toISOString();
}

