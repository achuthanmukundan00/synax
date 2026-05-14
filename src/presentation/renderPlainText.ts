/**
 * Deterministic plain-text renderer for CLI/benchmark output.
 *
 * Consumes PresentationState from the canonical presentation pipeline
 * and produces stable CLI output suitable for benchmarks, snapshots, and logs.
 *
 * Rules:
 * - No ANSI escape sequences
 * - No cursor positioning
 * - No animation or time-dependent content
 * - Stable chronological ordering
 * - Never prints raw chain-of-thought
 * - Never prints TUI layout artifacts
 */

import type { PresentationState, PresentationBlock } from './types';

export interface PlainTextOptions {
  /** Include model output blocks (default: true) */
  showModelOutput?: boolean;
  /** Include tool activity lines (default: true) */
  showToolActivity?: boolean;
  /** Include shell command results (default: true) */
  showShellCommands?: boolean;
  /** Include verification events (default: true) */
  showVerification?: boolean;
  /** Include patch previews (default: false) */
  showPatchPreviews?: boolean;
  /** Include runtime_status 'line' priority entries (default: true) */
  showRuntimeStatus?: boolean;
  /** Include runtime_status 'detail' and debug_detail blocks (default: false) */
  debugMode?: boolean;
  /** Include memory decisions (default: false) */
  showMemory?: boolean;
  /** Include handoff packets (default: false) */
  showHandoff?: boolean;
  /** Include agent panes (default: false) */
  showAgentPanes?: boolean;
  /** Max characters per line before truncation (default: 200) */
  maxLineLength?: number;
  /** Max lines for a single output block (default: 100) */
  maxBlockLines?: number;
}

const defaults: PlainTextOptions = {
  showModelOutput: true,
  showToolActivity: true,
  showShellCommands: true,
  showVerification: true,
  showPatchPreviews: false,
  showRuntimeStatus: true,
  debugMode: false,
  showMemory: false,
  showHandoff: false,
  showAgentPanes: false,
  maxLineLength: 200,
  maxBlockLines: 100,
};

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 3)) + '...';
}

export function renderPlainText(state: PresentationState, options?: PlainTextOptions): string {
  const opts = { ...defaults, ...options };
  const lines: string[] = [];

  for (const block of state.blocks) {
    const blockLines = renderBlock(block, opts);
    if (blockLines.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(...blockLines);
    }
  }

  // Render view-model arrays (memory, handoff, agent panes) if enabled
  if (opts.showMemory && state.memoryDecisions.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('[memory]');
    for (const d of state.memoryDecisions) {
      const attrs: string[] = [];
      if (d.stale) attrs.push('stale');
      if (d.conflict) attrs.push('conflict');
      lines.push(`  ${d.disposition}: ${d.label} ${attrs.length > 0 ? `(${attrs.join(', ')})` : ''}`);
    }
    if (state.liveRepoState) {
      const lrs = state.liveRepoState;
      if (lrs.cwd) lines.push(`  live cwd: ${lrs.cwd}`);
      if (lrs.branch) lines.push(`  live branch: ${lrs.branch}`);
    }
  }

  if (opts.showHandoff && state.handoffPackets.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('[handoff]');
    for (const h of state.handoffPackets) {
      lines.push(`  ${h.source} → ${h.target}: ${h.reason}`);
      if (h.summary) lines.push(`    ${h.summary}`);
    }
  }

  if (opts.showAgentPanes && state.agentPanes.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('[agents]');
    for (const a of state.agentPanes) {
      lines.push(`  ${a.id}: ${a.phase} — ${a.lastAction}`);
    }
  }

  return lines.join('\n') + '\n';
}

/** Render a single Presentations block to plain-text lines. */
function renderBlock(block: PresentationBlock, opts: PlainTextOptions): string[] {
  switch (block.kind) {
    case 'model_output': {
      if (!opts.showModelOutput) return [];
      const text = clip(block.text, opts.maxLineLength! * 3);
      switch (block.role) {
        case 'primary':
          return text.split('\n').slice(0, opts.maxBlockLines);
        case 'question':
          return [`Question: ${text}`];
        case 'note':
          if (!opts.debugMode) return [];
          return [`# ${text}`];
        default:
          return [];
      }
    }

    case 'tool_activity': {
      if (!opts.showToolActivity) return [];
      if (block.toolName === 'run_verification' && !opts.showVerification) return [];
      const status = block.phase === 'started' ? '' : ` — ${block.phase}`;
      const summary = clip(block.summary, opts.maxLineLength!);
      return [`[${block.toolName}] ${summary}${status}`];
    }

    case 'shell_command': {
      if (!opts.showShellCommands) return [];
      const duration =
        block.durationMs >= 1000 ? ` (${(block.durationMs / 1000).toFixed(1)}s)` : ` (${block.durationMs}ms)`;
      const exitStr = block.exitCode !== 0 ? ` [exit ${block.exitCode}]` : '';
      const cmdLine = `$ ${block.command}${exitStr}${duration}`;
      const result: string[] = [clip(cmdLine, opts.maxLineLength!)];
      if (block.stdout) {
        const stdout = clip(block.stdout.trim(), opts.maxLineLength! * 5)
          .split('\n')
          .slice(0, opts.maxBlockLines);
        result.push(...stdout.map((l) => `  ${l}`));
      }
      if (block.stderr) {
        const stderr = clip(block.stderr.trim(), opts.maxLineLength! * 5)
          .split('\n')
          .slice(0, opts.maxBlockLines);
        result.push(...stderr.map((l) => `  err: ${l}`));
      }
      return result;
    }

    case 'orchestration': {
      if (!opts.showToolActivity) return [];
      const agentCount = block.subAgents.length;
      const active = block.subAgents.filter((a) => a.phase === 'active').length;
      const done = block.subAgents.filter((a) => a.phase === 'completed').length;
      const failed = block.subAgents.filter((a) => a.phase === 'failed').length;
      const pending = block.subAgents.filter((a) => a.phase === 'pending').length;
      const summary = `${done}/${agentCount} done · ${active} active · ${failed} failed · ${pending} pending`;
      const result: string[] = [`[orchestration] ${block.mode} — ${summary}`];
      for (const agent of block.subAgents) {
        const note = agent.error
          ? ` — ${clip(agent.error, 60)}`
          : agent.changedFiles && agent.changedFiles.length > 0
            ? ` — ${agent.changedFiles.join(', ')}`
            : '';
        result.push(`  [${agent.id}] ${agent.phase}${note}`);
      }
      return result;
    }

    case 'runtime_status': {
      if (!opts.showRuntimeStatus && block.priority === 'line') return [];
      if (!opts.debugMode && block.priority === 'detail') return [];
      return [`[${block.label}] ${block.value}`];
    }

    case 'debug_detail': {
      if (!opts.debugMode) return [];
      if (block.tag === 'patch_preview' && !opts.showPatchPreviews) return [];
      const text = clip(block.text, opts.maxLineLength! * 5);
      return text
        .split('\n')
        .slice(0, opts.maxBlockLines)
        .map((l) => `# ${block.tag}: ${l}`);
    }
  }
}
