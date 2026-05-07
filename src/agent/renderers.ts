import type { AgentEvent } from './events';
export { TuiRenderer } from './tui-renderer';

export interface AgentRenderer {
  onEvent(event: AgentEvent): void;
  setModelOutput?(text: string): void;
  finish?(): void;
}

function kv(label: string, value: string): string {
  return `${label.padEnd(12)} ${value}`;
}

export class NormalRenderer implements AgentRenderer {
  private printedHeader = false;
  private eventIndex = 0;

  onEvent(event: AgentEvent): void {
    if (event.type === 'task_started') {
      this.printedHeader = true;
      process.stdout.write('Synax Task\n----------\n');
      process.stdout.write(`${kv('Mode:', event.mode)}\n`);
      process.stdout.write(`${kv('Profile:', event.profile)}\n`);
      process.stdout.write(`${kv('Endpoint:', event.endpoint)}\n`);
      process.stdout.write(`${kv('Model:', event.model)}\n`);
      process.stdout.write(`${kv('Context:', String(event.contextBudgetTokens))}\n`);
      process.stdout.write(`${kv('Tools:', event.tools.join(', '))}\n\n`);
      process.stdout.write('Task:\n');
      process.stdout.write(`  ${event.task}\n\n`);
      process.stdout.write('Events\n------\n');
      return;
    }
    if (event.type === 'tool_started') {
      this.eventIndex += 1;
      process.stdout.write(`[${this.eventIndex}] ${event.toolName} ${event.summary}\n`);
      return;
    }
    if (event.type === 'tool_finished') {
      process.stdout.write(`      ${event.status === 'ok' ? 'ok' : 'error'}: ${event.summary}\n\n`);
      return;
    }
    if (event.type === 'patch_preview') {
      process.stdout.write(`      preview: ${event.path}\n`);
      process.stdout.write(`${event.diff}\n\n`);
      return;
    }
    if (event.type === 'verification_planned') {
      process.stdout.write(`${kv('Verif plan:', `${event.checkLabel} (${event.summary ?? 'planned'})`)}\n`);
      return;
    }
    if (event.type === 'verification_started') {
      process.stdout.write(
        `${kv('Verif start:', `${event.checkLabel}${event.command ? ` → ${event.command}` : ''}`)}\n`,
      );
      return;
    }
    if (event.type === 'verification_passed') {
      const dur = event.durationMs !== undefined ? ` (${formatDurationNormal(event.durationMs)})` : '';
      process.stdout.write(`${kv('Verif ✓:', `${event.checkLabel}${dur}`)}\n`);
      return;
    }
    if (event.type === 'verification_failed') {
      const dur = event.durationMs !== undefined ? ` (${formatDurationNormal(event.durationMs)})` : '';
      process.stdout.write(`${kv('Verif ✗:', `${event.checkLabel}${dur}`)}\n`);
      if (event.summary) process.stdout.write(`${kv('', event.summary)}\n`);
      return;
    }
    if (event.type === 'verification_skipped') {
      process.stdout.write(`${kv('Verif skip:', event.checkLabel)}\n`);
      return;
    }
    if (event.type === 'task_finished') {
      if (!this.printedHeader) return;
      process.stdout.write('Result\n------\n');
      process.stdout.write(`${kv('Status:', event.status)}\n`);
      process.stdout.write(`${kv('Tool calls:', `${event.toolCalls} / ${event.maxToolCalls}`)}\n`);
      process.stdout.write(`${kv('Model steps:', `${event.modelSteps} / ${event.maxModelSteps}`)}\n`);
      process.stdout.write(`${kv('Changed:', `${event.changedFiles.length} files`)}\n`);
      process.stdout.write(`${kv('Verified:', event.verification)}\n`);
      if (event.error) process.stdout.write(`${kv('Error:', event.error)}\n`);
      process.stdout.write('\n');
      return;
    }
    if (event.type === 'assistant_message' && event.content.trim()) {
      process.stdout.write(`${event.content.trim()}\n`);
    }
  }
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

function formatDurationNormal(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

function redact(value: string): string {
  return value
    .replace(/([?&](?:api[_-]?key|token|secret|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+["']?[^"',\s}]+/gi, 'Bearer [REDACTED]')
    .replace(/(Authorization["']?\s*:\s*["']?)[^"',}]+/gi, '$1[REDACTED]')
    .replace(/\bsecret\b/gi, '[REDACTED]');
}
