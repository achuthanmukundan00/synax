/**
 * `synax inspect --metrics` command implementation.
 *
 * Displays recent run history, per-session event timelines, and aggregate
 * statistics from the SQLite EventStore.
 *
 * Modes:
 *   synax inspect --metrics              → recent sessions table (last 20)
 *   synax inspect --metrics --session <id> → event timeline for session
 *   synax inspect --metrics --stats        → aggregate statistics
 *   All modes support --json for machine-readable output.
 */

import type { EventStore, SessionRecord } from '../store/EventStore';

export interface MetricsOptions {
  json?: boolean;
  session?: string;
  stats?: boolean;
}

/**
 * Run the metrics dashboard.
 * Returns silently if the event store is unavailable or empty.
 */
export function runMetricsCommand(store: EventStore | undefined, options: MetricsOptions): void {
  if (!store?.isOpen) {
    console.log('[synax] Event store is not available. Run a chat/ask session first.');
    return;
  }

  if (options.stats) {
    runStats(store, options);
  } else if (options.session) {
    runTimeline(store, options.session, options);
  } else {
    runRecentSessions(store, options);
  }
}

// ─── Recent Sessions ─────────────────────────────────────────────────────────

function runRecentSessions(store: EventStore, options: MetricsOptions): void {
  const sessions = store.getRecentSessions(20);

  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log('[synax] No sessions recorded yet. Run a chat/ask session first.');
    return;
  }

  printSessionsTable(sessions);
}

function printSessionsTable(sessions: SessionRecord[]): void {
  const header = ['Date', 'Mode', 'Model', 'Steps', 'Tool Calls', 'Status', 'Files'];
  const rows = sessions.map((s) => [
    formatDate(s.createdAt),
    s.mode,
    truncate(s.model, 20),
    String(s.steps ?? 0),
    String(s.toolCalls ?? 0),
    statusLabel(s.terminalState),
    String((s.changedFiles ?? []).length),
  ]);

  printTable(header, rows);
}

// ─── Session Timeline ────────────────────────────────────────────────────────

function runTimeline(store: EventStore, sessionId: string, options: MetricsOptions): void {
  const events = store.getSessionTimeline(sessionId);

  if (options.json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  if (events.length === 0) {
    console.log(`[synax] No events found for session: ${sessionId}`);
    return;
  }

  console.log(`Session: ${sessionId}`);
  console.log(`Events: ${events.length}`);
  console.log('');

  for (const ev of events) {
    const time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '--:--:--';
    const step = ev.stepIndex !== undefined ? `step ${ev.stepIndex}` : '';
    const tool = ev.toolName ? ` ${ev.toolName}` : '';
    const summary = eventSummary(ev);
    console.log(`  ${time}  ${ev.type.padEnd(24)} ${step}${tool}  ${summary}`);
  }
}

function eventSummary(ev: { type: string; payload: Record<string, unknown> }): string {
  const p = ev.payload;
  switch (ev.type) {
    case 'task_started':
      return `task: ${truncate(String(p.task ?? ''), 60)}`;
    case 'tool_started':
      return truncate(String(p.summary ?? ''), 60);
    case 'tool_finished':
      return `${p.status ?? '?'} ${truncate(String(p.summary ?? ''), 50)}`;
    case 'model_step_started':
      return `step ${p.stepIndex ?? '?'}`;
    case 'task_finished':
      return `status=${p.status ?? '?'} steps=${p.modelSteps ?? 0} tools=${p.toolCalls ?? 0}`;
    case 'error':
      return truncate(String(p.message ?? ''), 60);
    default:
      return '';
  }
}

// ─── Aggregate Stats ─────────────────────────────────────────────────────────

function runStats(store: EventStore, options: MetricsOptions): void {
  const stats = store.getAggregateStats();
  const tokenStats = store.getTokenStats();

  if (options.json) {
    console.log(JSON.stringify({ ...stats, tokenStats }, null, 2));
    return;
  }

  if (stats.totalSessions === 0) {
    console.log('[synax] No sessions recorded yet. Run a chat/ask session first.');
    return;
  }

  console.log('Synax Run Statistics (last 30 days)');
  console.log('===================================');
  console.log(`  Total sessions:      ${stats.totalSessions}`);
  console.log(`  Completed:           ${stats.completedSessions}`);
  console.log(`  Failed:              ${stats.failedSessions}`);
  console.log(`  Success rate:        ${stats.successRate}%`);
  console.log(`  Avg steps / session: ${stats.avgSteps}`);
  console.log(`  Avg tool calls:      ${stats.avgToolCalls}`);
  console.log(`  Total tool calls:    ${stats.totalToolCalls}`);
  console.log('');

  if (tokenStats.turnCount > 0) {
    console.log('Token Usage (all sessions):');
    console.log(`  Total input tokens:   ${tokenStats.totalInputTokens.toLocaleString()}`);
    console.log(`  Total output tokens:  ${tokenStats.totalOutputTokens.toLocaleString()}`);
    console.log(`  Total tokens:         ${tokenStats.totalTokens.toLocaleString()}`);
    if (tokenStats.totalEstimatedCost > 0) {
      console.log(`  Estimated cost:       $${tokenStats.totalEstimatedCost.toFixed(4)}`);
    } else {
      console.log(`  Estimated cost:       $0.00 (local models)`);
    }
    console.log(`  Model turns tracked:  ${tokenStats.turnCount}`);
    console.log('');
  }

  if (stats.topModels.length > 0) {
    console.log('Top Models:');
    for (const m of stats.topModels) {
      console.log(`  ${m.model.padEnd(30)} ${m.count} sessions`);
    }
    console.log('');
  }

  if (stats.topFailureModes.length > 0) {
    console.log('Top Failure Modes:');
    for (const f of stats.topFailureModes) {
      console.log(`  ${f.state.padEnd(30)} ${f.count} sessions`);
    }
    console.log('');
  }
}

// ─── Table Formatting ────────────────────────────────────────────────────────

function printTable(header: string[], rows: string[][]): void {
  // Compute column widths
  const widths = header.map((h, i) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), 0);
    return Math.max(h.length, dataMax);
  });

  const pad = (text: string, width: number): string => text.padEnd(width);

  // Header
  const headerLine = header.map((h, i) => pad(h, widths[i])).join(' │ ');
  const separator = widths.map((w) => '─'.repeat(w)).join('─┼─');

  console.log(headerLine);
  console.log(separator);

  // Rows
  for (const row of rows) {
    const line = row.map((cell, i) => pad(cell, widths[i])).join(' │ ');
    console.log(line);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso.slice(0, 16);
  }
}

function statusLabel(state: string | undefined): string {
  if (!state) return 'running';
  switch (state) {
    case 'completed':
      return 'completed';
    case 'budget_exhausted':
      return 'budget';
    case 'blocked':
      return 'blocked';
    case 'model_error':
      return 'model err';
    case 'tool_error':
      return 'tool err';
    case 'failed_verification':
      return 'verify fail';
    case 'user_input_required':
      return 'input';
    default:
      return state;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}
