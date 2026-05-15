/**
 * Pure key-handler and utility functions extracted from interactive-tui.ts.
 *
 * These are stateless — they don't close over any TUI runtime state.
 * Moving them here lets them be unit-tested in isolation (no terminal
 * dependency) and reduces the token cost of editing interactive-tui.ts.
 */

import { filterCommands } from '../settings/slash-command-registry';
import { CTRL_C_QUIT_TIMEOUT_MS } from './tui-constants';
import type { SemanticEvent } from './semantic-events';

// ─── Ctrl+C double-press behavior resolver ───────────────────────────────────

export function resolveCtrlCBehavior(input: {
  prompt: string;
  busy: boolean;
  previousPressAtMs: number | null;
  nowMs: number;
}): 'interrupt' | 'clear_prompt' | 'arm_quit' | 'quit' {
  if (input.busy) return 'interrupt';
  if (input.prompt.length > 0) return 'clear_prompt';
  if (input.previousPressAtMs !== null && input.nowMs - input.previousPressAtMs < CTRL_C_QUIT_TIMEOUT_MS) return 'quit';
  return 'arm_quit';
}

// ─── Expand/collapse target finder ───────────────────────────────────────────

export function latestExpandableEventId(events: SemanticEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (event.artifact.type === 'diff' && event.artifact.hunks.length > 12) return event.id;
    if (event.artifact.type === 'command') {
      const outputLines =
        (event.artifact.stdout?.split('\n').filter(Boolean).length ?? 0) +
        (event.artifact.stderr?.split('\n').filter(Boolean).length ?? 0);
      if (outputLines > 0) return event.id;
    }
    if (event.artifact.type === 'tool_result' && event.artifact.output) return event.id;
    if (event.artifact.type === 'text' && event.artifact.body.split('\n').length > 8) return event.id;
  }
  return undefined;
}

// ─── Slash command autocomplete ──────────────────────────────────────────────

const LOCAL_SLASH_COMMANDS = ['/theme', '/checkpoint', '/restore', '/checkpoints', '/doctor'];

export function slashAutocompleteItems(input: string): string[] {
  if (!input.startsWith('/')) return [];
  const query = input.slice(1).trimStart().toLowerCase();
  const primary = filterCommands(query).map((command) => `/${command.name}`);
  const local = LOCAL_SLASH_COMMANDS.filter((command) => command.slice(1).includes(query.toLowerCase()));
  return unique([...primary, ...local]).sort((a, b) => a.localeCompare(b));
}

// ─── Prompt cursor navigation ────────────────────────────────────────────────

export function movePromptCursorVertically(input: unknown, direction: 'up' | 'down'): boolean {
  const promptInput = input as
    | {
        plainText?: string;
        cursorOffset?: number;
        moveCursorUp?: () => boolean;
        moveCursorDown?: () => boolean;
      }
    | undefined;
  if (!promptInput) return false;
  const text = readPromptValue(promptInput);
  if (!text.includes('\n')) return false;
  const moved = direction === 'up' ? promptInput.moveCursorUp?.() : promptInput.moveCursorDown?.();
  if (moved) return true;
  if (typeof promptInput.cursorOffset !== 'number') return false;
  const nextOffset =
    direction === 'up'
      ? lineStartOffset(text, promptInput.cursorOffset)
      : lineEndOffset(text, promptInput.cursorOffset);
  if (nextOffset === promptInput.cursorOffset) return false;
  promptInput.cursorOffset = nextOffset;
  return true;
}

// ─── Artifact history scrolling ──────────────────────────────────────────────

export function scrollArtifactHistory(
  renderer: { root: { findDescendantById(id: string): unknown }; height?: number },
  deltaRows: number,
): boolean {
  const scrollBox = renderer.root.findDescendantById('synax-artifacts') as
    | {
        scrollBy?: (delta: number | { x: number; y: number }, unit?: string) => void;
        stickyScroll?: boolean;
      }
    | undefined;
  if (!scrollBox || typeof scrollBox.scrollBy !== 'function') return false;
  if (deltaRows < 0 && 'stickyScroll' in scrollBox) {
    scrollBox.stickyScroll = false;
  }
  scrollBox.scrollBy(deltaRows);
  return true;
}

// ─── Prompt value helpers ────────────────────────────────────────────────────

export function readPromptValue(input: unknown): string {
  const promptInput = input as { plainText?: string; value?: string };
  return typeof promptInput.plainText === 'string' ? promptInput.plainText : (promptInput.value ?? '');
}

export function setPromptValue(input: unknown, value: string): void {
  const promptInput = input as { setText?: (text: string) => void; value?: string };
  if (!promptInput) return;
  if (typeof promptInput.setText === 'function') {
    promptInput.setText(value);
    return;
  }
  promptInput.value = value;
}

// ─── Text/Cursor utilities ───────────────────────────────────────────────────

export function lineStartOffset(text: string, cursorOffset: number): number {
  return text.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1;
}

export function lineEndOffset(text: string, cursorOffset: number): number {
  const nextNewline = text.indexOf('\n', cursorOffset);
  return nextNewline === -1 ? text.length : nextNewline;
}

export function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

export function truncateTitle(ev: SemanticEvent): string {
  if (ev.artifact.type === 'plan' || ev.artifact.type === 'tool_result' || ev.artifact.type === 'checkpoint') {
    return ev.artifact.title.slice(0, 60);
  }
  if (ev.artifact.type === 'edit' || ev.artifact.type === 'diff') {
    return ev.artifact.file.split('/').pop() ?? ev.artifact.file.slice(0, 60);
  }
  if (ev.artifact.type === 'command') {
    return ev.artifact.command.slice(0, 60);
  }
  if (ev.artifact.type === 'text') {
    return ev.artifact.title.slice(0, 60);
  }
  if (ev.artifact.type === 'status') {
    return ev.artifact.label.slice(0, 60);
  }
  return '';
}

// ─── Theme names ─────────────────────────────────────────────────────────────

export function getThemeNames(): string[] {
  return ['default', 'dark', 'light', 'high-contrast'];
}

// ─── Misc ────────────────────────────────────────────────────────────────────

export function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function splashFrame(nowMs: number): number {
  return Math.floor(nowMs / 500);
}

export function tuiNote(kind: 'slash' | 'error', body: string): SemanticEvent {
  return {
    id: `${kind}-${Date.now()}`,
    class: kind === 'error' ? 'error' : 'note',
    timestamp: Date.now(),
    artifact: {
      type: 'text',
      title: kind === 'error' ? 'Error' : 'Command',
      body,
    },
    metadata: {},
  };
}
