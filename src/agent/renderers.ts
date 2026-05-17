import type { AgentEvent } from './events';

export interface AgentRenderer {
  onEvent(event: AgentEvent): void;
  setModelOutput?(text: string): void;
  finish?(): void;
}

export class QuietRenderer implements AgentRenderer {
  onEvent(event: AgentEvent): void {
    if (event.type === 'assistant_message' && event.content.trim()) {
      process.stdout.write(`${event.content.trim()}\n`);
    }
    if (event.type === 'task_finished' && event.status !== 'completed' && event.error) {
      process.stderr.write(`${event.error}\n`);
    }
  }
}

export class JsonlRenderer implements AgentRenderer {
  onEvent(event: AgentEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

export class DebugRenderer implements AgentRenderer {
  onEvent(event: AgentEvent): void {
    process.stdout.write(`[debug] event: ${event.type}\n`);
    if (event.stepIndex !== undefined) process.stdout.write(`  step: ${event.stepIndex}\n`);

    if (event.type === 'task_started') {
      process.stdout.write(`  endpoint: ${redact(event.endpoint)}\n`);
      process.stdout.write(`  model: ${event.model}\n`);
      process.stdout.write(`  tools: ${event.tools.join(', ')}\n`);
      process.stdout.write(
        `  budgets: context=${event.contextBudgetTokens} model_steps=unlimited tool_calls=${event.maxToolCalls}\n`,
      );
      process.stdout.write(`  content: ${preview(event.task)}\n`);
      return;
    }

    if (event.type === 'tool_started') {
      process.stdout.write(`  tool: ${event.toolName} args=${preview(event.summary)}\n`);
      return;
    }

    if (event.type === 'tool_finished') {
      process.stdout.write(
        `  tool: ${event.toolName} status=${event.status ?? 'unknown'} result=${preview(event.summary)}\n`,
      );
      return;
    }

    if (event.type === 'assistant_message') {
      process.stdout.write(`  content: ${preview(event.content)}\n`);
      return;
    }

    if (event.type === 'patch_preview') {
      process.stdout.write(`  patch: ${event.path}\n`);
      process.stdout.write(`  diff: ${preview(event.diff)}\n`);
      return;
    }

    if (event.type === 'task_finished') {
      process.stdout.write(`  terminal: ${event.status}\n`);
      process.stdout.write(`  model_steps: ${event.modelSteps}\n`);
      process.stdout.write(`  tool_calls: ${event.toolCalls} / ${event.maxToolCalls}\n`);
      process.stdout.write(`  changed_files: ${event.changedFiles.length}\n`);
      process.stdout.write(`  verification: ${event.verification}\n`);
      if (event.error) process.stdout.write(`  error: ${preview(event.error)}\n`);
      return;
    }

    if (event.type === 'error') {
      process.stdout.write(`  error: ${preview(event.message)}\n`);
    }
  }
}

function preview(value: string): string {
  const redacted = redact(value).replace(/\s+/g, ' ').trim();
  return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
}

function redact(value: string): string {
  return value
    .replace(/([?&](?:api[_-]?key|token|secret|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+["']?[^"',\s}]+/gi, 'Bearer [REDACTED]')
    .replace(/(Authorization["']?\s*:\s*["']?)[^"',}]+/gi, '$1[REDACTED]')
    .replace(/\bsecret\b/gi, '[REDACTED]');
}
