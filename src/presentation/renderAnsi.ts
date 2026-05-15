/**
 * Morphology ANSI renderer for the Synax presentation layer.
 *
 * Consumes PresentationState + Theme and renders a distinctive,
 * glyph-led TUI layout using horizontal rules, whitespace, indentation,
 * and ANSI color. No vertical box-drawing characters are used.
 *
 * This renderer sits on top of the existing event→presentation adapter
 * (reduceEvent.ts) — it does not create a new event bus.
 */

import type { Theme } from './theme';
import { glyphLabel, hrLine, kvLine, badge } from './theme';
import type {
  PresentationState,
  PresentationBlock,
  SubAgentSummary,
  MemoryDecision,
  HandoffPacketView,
  AgentPaneView,
} from './types';

export interface AnsiRenderOptions {
  /** Terminal width in columns. Defaults to 80. */
  terminalWidth?: number;
  /** Whether to include the run header block. */
  showHeader?: boolean;
  /** Whether to render memory decisions section. */
  showMemory?: boolean;
  /** Whether to render handoff packets section. */
  showHandoff?: boolean;
  /** Whether to render agent panes section. */
  showAgentPanes?: boolean;
}

/** Primary render: produces a string suitable for terminal output. */
export function renderAnsi(state: PresentationState, theme: Theme, options?: AnsiRenderOptions): string {
  const opts = resolveOptions(options);
  const tw = opts.terminalWidth;
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────
  if (opts.showHeader) {
    lines.push(renderHeader(state, theme, tw));
    lines.push(hrLine(theme, tw));
    if (theme.blockPadding > 0) lines.push('');
  }

  // ── Blocks ──────────────────────────────────────────────────────────
  const renderedBlocks = state.blocks.map((block, i) => renderBlock(block, theme, tw, i));
  for (let i = 0; i < renderedBlocks.length; i++) {
    const block = renderedBlocks[i];
    if (block === null) continue;
    lines.push(block);
    // Add padding between major blocks
    if (theme.blockPadding > 0 && i < renderedBlocks.length - 1) {
      const next = renderedBlocks[i + 1];
      if (next !== null) {
        lines.push('');
      }
    }
  }

  // Streaming text: show live with synthesis glyph
  if (state.streamingText.trim()) {
    lines.push('');
    lines.push(glyphLabel(theme, theme.glyphs.synthesis, 'synthesis', 'synthesis'));
    lines.push('');
    const indent = ' '.repeat(theme.contentIndent);
    lines.push(`${indent}${theme.ansi(theme.colors.muted)}${state.streamingText}${theme.reset}`);
  }

  // ── Major section: Memory ───────────────────────────────────────────
  if (opts.showMemory && state.memoryDecisions.length > 0) {
    lines.push('');
    lines.push(hrLine(theme, tw));
    lines.push('');
    lines.push(glyphLabel(theme, theme.glyphs.memory, 'memory', 'memory'));
    lines.push('');
    lines.push(renderMemorySection(state.memoryDecisions, state.liveRepoState, theme));
  }

  // ── Major section: Handoff ──────────────────────────────────────────
  if (opts.showHandoff && state.handoffPackets.length > 0) {
    lines.push('');
    lines.push(hrLine(theme, tw));
    lines.push('');
    lines.push(glyphLabel(theme, theme.glyphs.handoff, 'handoff', 'handoff'));
    lines.push('');
    lines.push(renderHandoffSection(state.handoffPackets, theme));
  }

  // ── Major section: Agent panes ──────────────────────────────────────
  if (opts.showAgentPanes && state.agentPanes.length > 0) {
    lines.push('');
    lines.push(hrLine(theme, tw));
    lines.push('');
    lines.push(renderAgentPanesSection(state.agentPanes, theme, tw));
  }

  return lines.join('\n') + '\n';
}

// ─── Block renderers ──────────────────────────────────────────────────────────────

function renderBlock(block: PresentationBlock, theme: Theme, tw: number, _index: number): string | null {
  switch (block.kind) {
    case 'model_output':
      return renderModelOutput(block, theme);
    case 'tool_activity':
      return renderToolActivity(block, theme);
    case 'shell_command':
      return renderShellCommand(block, theme);
    case 'orchestration':
      return renderOrchestration(block, theme, tw);
    case 'runtime_status':
      return renderRuntimeStatus(block, theme);
    case 'debug_detail':
      return renderDebugDetail(block, theme);
    default:
      return null;
  }
}

// ─── Model output ─────────────────────────────────────────────────────────────────

function renderModelOutput(block: Extract<PresentationBlock, { kind: 'model_output' }>, theme: Theme): string {
  const roleLabel = block.role === 'question' ? 'question' : 'result';
  const glyph = block.role === 'question' ? theme.glyphs.question : theme.glyphs.result;
  const colorKey = block.role === 'question' ? 'user' : 'result';

  const lines: string[] = [];
  lines.push(glyphLabel(theme, glyph, roleLabel, colorKey));
  lines.push('');
  const indent = ' '.repeat(theme.contentIndent);
  const text = block.text.trim();
  if (text) {
    for (const line of text.split('\n')) {
      lines.push(`${indent}${line}`);
    }
  }
  return lines.join('\n');
}

// ─── Tool activity ────────────────────────────────────────────────────────────────

function renderToolActivity(block: Extract<PresentationBlock, { kind: 'tool_activity' }>, theme: Theme): string {
  const lines: string[] = [];

  let statusBadge: string;
  if (block.phase === 'failed') {
    statusBadge = badge(theme, 'failed', 'error');
  } else if (block.phase === 'started') {
    statusBadge = badge(theme, 'running', 'info');
  } else {
    statusBadge = badge(theme, 'ok', 'ok');
  }

  lines.push(`${glyphLabel(theme, theme.glyphs.tool, 'tool', 'tool')}  ${statusBadge}`);
  lines.push('');
  lines.push(kvLine(theme, 'tool', block.toolName, theme.contentIndent + 2));
  lines.push(kvLine(theme, 'phase', block.phase, theme.contentIndent + 2));

  if (block.summary) {
    lines.push('');
    const indent = ' '.repeat(theme.contentIndent);
    lines.push(`${indent}${block.summary}`);
  }

  if (block.detail) {
    lines.push('');
    const indent = ' '.repeat(theme.contentIndent);
    lines.push(`${indent}${theme.ansi(theme.colors.muted)}${block.detail.slice(0, 200)}${theme.reset}`);
  }

  return lines.join('\n');
}

// ─── Shell command ────────────────────────────────────────────────────────────────

function renderShellCommand(block: Extract<PresentationBlock, { kind: 'shell_command' }>, theme: Theme): string {
  const lines: string[] = [];
  const exitOk = block.exitCode === 0;
  const status = exitOk ? badge(theme, 'ok', 'ok') : badge(theme, `exit ${block.exitCode}`, 'error');

  lines.push(`${glyphLabel(theme, theme.glyphs.tool, 'shell', 'tool')}  ${status}`);
  lines.push('');
  lines.push(kvLine(theme, 'command', block.command, theme.contentIndent + 2));
  lines.push(kvLine(theme, 'duration', `${block.durationMs}ms`, theme.contentIndent + 2));

  if (block.stdout) {
    lines.push('');
    const indent = ' '.repeat(theme.contentIndent);
    const out = block.stdout.slice(0, 300);
    lines.push(`${indent}${theme.ansi(theme.colors.muted)}${out}${theme.reset}`);
  }
  if (block.stderr) {
    lines.push('');
    const indent = ' '.repeat(theme.contentIndent);
    lines.push(`${indent}${theme.ansi(theme.colors.error)}${block.stderr.slice(0, 200)}${theme.reset}`);
  }

  return lines.join('\n');
}

// ─── Orchestration ────────────────────────────────────────────────────────────────

function renderOrchestration(
  block: Extract<PresentationBlock, { kind: 'orchestration' }>,
  theme: Theme,
  _tw: number,
): string {
  const lines: string[] = [];

  const modeLabel = block.mode === 'handoff' ? 'handoff' : block.mode === 'parallel' ? 'parallel' : 'sequential';
  const phaseBadge =
    block.phase === 'completed'
      ? badge(theme, 'done', 'ok')
      : block.phase === 'failed'
        ? badge(theme, 'failed', 'error')
        : badge(theme, block.phase, 'info');

  lines.push(
    `${glyphLabel(theme, theme.glyphs.synthesis, `orchestration · ${modeLabel}`, 'synthesis')}  ${phaseBadge}`,
  );
  lines.push('');
  lines.push(kvLine(theme, 'summary', block.summary, theme.contentIndent + 2));

  if (block.subAgents.length > 0) {
    lines.push('');
    lines.push(`${' '.repeat(theme.contentIndent)}${theme.ansi(theme.colors.label)}sub-agents:${theme.reset}`);
    for (const sa of block.subAgents) {
      lines.push(renderSubAgentSummary(sa, theme));
    }
  }

  return lines.join('\n');
}

function renderSubAgentSummary(sa: SubAgentSummary, theme: Theme): string {
  const glyph = sa.phase === 'completed' ? theme.glyphs.result : theme.glyphs.subagent;
  const colorKey: 'result' | 'subagent' = sa.phase === 'completed' ? 'result' : 'subagent';
  const indent = ' '.repeat(theme.contentIndent + 2);
  const phaseBadge =
    sa.phase === 'completed'
      ? badge(theme, 'done', 'ok')
      : sa.phase === 'failed'
        ? badge(theme, 'failed', 'error')
        : badge(theme, sa.phase, 'info');

  const lines: string[] = [];
  lines.push(`${indent}${theme.ansi(theme.colors[colorKey])}${glyph}${theme.reset} ${sa.id}  ${phaseBadge}`);
  lines.push(`${indent}  ${theme.ansi(theme.colors.muted)}${sa.task}${theme.reset}`);
  if (sa.error) {
    lines.push(`${indent}  ${theme.ansi(theme.colors.error)}error: ${sa.error}${theme.reset}`);
  }
  if (sa.changedFiles && sa.changedFiles.length > 0) {
    lines.push(`${indent}  ${theme.ansi(theme.colors.key)}files:${theme.reset} ${sa.changedFiles.join(', ')}`);
  }
  return lines.join('\n');
}

// ─── Runtime status ───────────────────────────────────────────────────────────────

function renderRuntimeStatus(block: Extract<PresentationBlock, { kind: 'runtime_status' }>, theme: Theme): string {
  if (block.priority === 'line') {
    return kvLine(theme, block.label, block.value);
  }
  return `${' '.repeat(theme.contentIndent)}${theme.ansi(theme.colors.muted)}${block.label}: ${block.value}${theme.reset}`;
}

// ─── Debug detail ─────────────────────────────────────────────────────────────────

function renderDebugDetail(block: Extract<PresentationBlock, { kind: 'debug_detail' }>, theme: Theme): string {
  const lines: string[] = [];
  lines.push(`${' '.repeat(theme.contentIndent)}${theme.ansi(theme.colors.muted)}[debug: ${block.tag}]${theme.reset}`);
  const indent = ' '.repeat(theme.contentIndent + 2);
  for (const line of block.text.split('\n')) {
    lines.push(`${indent}${theme.ansi(theme.colors.muted)}${line}${theme.reset}`);
  }
  return lines.join('\n');
}

// ─── Header ───────────────────────────────────────────────────────────────────────

function renderHeader(state: PresentationState, theme: Theme, tw: number): string {
  const lr = state.liveRepoState;
  const parts: string[] = [];

  parts.push(theme.ansi(theme.colors.header) + 'synax' + theme.reset);

  // Model info from runtime_status blocks
  const modelBlock = state.blocks.find(
    (b): b is Extract<PresentationBlock, { kind: 'runtime_status' }> =>
      b.kind === 'runtime_status' && b.priority === 'line' && b.label === 'model',
  );
  if (modelBlock) {
    parts.push(theme.ansi(theme.colors.dim) + modelBlock.value + theme.reset);
  } else {
    parts.push(theme.ansi(theme.colors.dim) + 'local' + theme.reset);
  }

  if (lr.cwd) {
    parts.push(theme.ansi(theme.colors.muted) + lr.cwd + theme.reset);
  }
  if (lr.repo) {
    parts.push(theme.ansi(theme.colors.muted) + lr.repo + theme.reset);
  }
  if (lr.branch) {
    parts.push(theme.ansi(theme.colors.muted) + lr.branch + theme.reset);
  }

  // Calculate elapsed from first block timestamp would need TimingInfo
  // For now render the header without elapsed

  const header = parts.join('    ');
  // Pad header with trailing spaces to visually fill the line
  const padWidth = Math.max(0, tw - visibleLength(header));
  return header + ' '.repeat(padWidth);
}

// ─── Memory section ───────────────────────────────────────────────────────────────

function renderMemorySection(
  decisions: MemoryDecision[],
  liveRepo: PresentationState['liveRepoState'],
  theme: Theme,
): string {
  const lines: string[] = [];

  // Show live repo state for staleness comparison
  if (liveRepo.cwd || liveRepo.branch || liveRepo.repo) {
    lines.push(kvLine(theme, 'live state', '', theme.contentIndent));
    if (liveRepo.cwd) lines.push(kvLine(theme, '  cwd', liveRepo.cwd, theme.contentIndent + 2));
    if (liveRepo.repo) lines.push(kvLine(theme, '  repo', liveRepo.repo, theme.contentIndent + 2));
    if (liveRepo.branch) lines.push(kvLine(theme, '  branch', liveRepo.branch, theme.contentIndent + 2));
    lines.push('');
  }

  for (const d of decisions) {
    const dispChar =
      d.disposition === 'used'
        ? badge(theme, '✓', 'ok')
        : d.disposition === 'ignored'
          ? badge(theme, '−', 'warn')
          : d.disposition === 'rejected'
            ? badge(theme, '×', 'error')
            : badge(theme, '⊘', 'warn');

    const dispLabel = `${dispChar} ${d.disposition}`;
    const label = d.conflict
      ? `${d.label} ${badge(theme, 'conflict', 'warn')}`
      : d.stale
        ? `${d.label} ${badge(theme, 'stale', 'warn')}`
        : d.label;

    lines.push(kvLine(theme, dispLabel, label, theme.contentIndent));

    if (d.reason) {
      lines.push(kvLine(theme, '  reason', d.reason, theme.contentIndent + 2));
    }
    if (d.provenance) {
      lines.push(kvLine(theme, '  provenance', d.provenance, theme.contentIndent + 2));
    }
  }

  return lines.join('\n');
}

// ─── Handoff section ──────────────────────────────────────────────────────────────

function renderHandoffSection(packets: HandoffPacketView[], theme: Theme): string {
  const lines: string[] = [];

  for (const p of packets) {
    lines.push(
      `${' '.repeat(theme.contentIndent)}${theme.ansi(theme.colors.handoff)}${theme.glyphs.handoff}${theme.reset} ${theme.ansi(theme.colors.label)}${p.source} → ${p.target}${theme.reset}`,
    );
    lines.push('');
    lines.push(kvLine(theme, 'reason', p.reason, theme.contentIndent + 2));
    lines.push(kvLine(theme, 'summary', p.summary, theme.contentIndent + 2));

    if (p.includedContext.length > 0) {
      lines.push('');
      lines.push(kvLine(theme, 'included', p.includedContext.join(', '), theme.contentIndent + 2));
    }
    if (p.excludedContext.length > 0) {
      lines.push(kvLine(theme, 'excluded', p.excludedContext.join(', '), theme.contentIndent + 2));
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Agent panes section ──────────────────────────────────────────────────────────

function renderAgentPanesSection(panes: AgentPaneView[], theme: Theme, _tw: number): string {
  const lines: string[] = [];

  // Stack panes vertically (not multi-column, to avoid fragile alignment)
  for (const pane of panes) {
    const phaseBadge =
      pane.phase === 'active'
        ? badge(theme, 'active', 'info')
        : pane.phase === 'completed'
          ? badge(theme, 'done', 'ok')
          : pane.phase === 'failed'
            ? badge(theme, 'failed', 'error')
            : badge(theme, 'pending', 'warn');

    lines.push(
      `${' '.repeat(theme.contentIndent)}${theme.ansi(theme.colors.subagent)}${theme.glyphs.subagent}${theme.reset} ${theme.ansi(theme.colors.label)}${pane.role}${theme.reset} ${phaseBadge}`,
    );
    lines.push(kvLine(theme, 'agent', pane.id, theme.contentIndent + 2));
    lines.push(kvLine(theme, 'model', pane.model, theme.contentIndent + 2));
    lines.push(kvLine(theme, 'last action', pane.lastAction, theme.contentIndent + 2));
    if (pane.finding) {
      lines.push(kvLine(theme, 'finding', pane.finding, theme.contentIndent + 2));
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────

function resolveOptions(options?: AnsiRenderOptions): Required<AnsiRenderOptions> {
  return {
    terminalWidth: options?.terminalWidth ?? 80,
    showHeader: options?.showHeader ?? true,
    showMemory: options?.showMemory ?? true,
    showHandoff: options?.showHandoff ?? true,
    showAgentPanes: options?.showAgentPanes ?? true,
  };
}

/** Approximate visible length of a string (strip ANSI sequences). */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '').length;
}
