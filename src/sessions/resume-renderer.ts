/**
 * Resume session picker state and renderer.
 *
 * Keyboard-navigable session picker for /resume command.
 * Renders plain text with ANSI styling — the TUI settings overlay
 * wraps each line in a solid-background Text node.
 */
import type { SessionMetadata } from './session-store';

// ─── State ──────────────────────────────────────────────────

export type ResumeSortField = 'updated' | 'created';

export interface ResumePickerState {
  active: boolean;
  selectedRow: number;
  searchQuery: string;
  sortBy: ResumeSortField;
  sessions: SessionMetadata[];
  filtered: SessionMetadata[];
}

export function createResumePickerState(sessions: SessionMetadata[]): ResumePickerState {
  return {
    active: false,
    selectedRow: 0,
    searchQuery: '',
    sortBy: 'updated',
    sessions,
    filtered: sessions,
  };
}

// ─── Actions ────────────────────────────────────────────────

export type ResumePickerAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'move_up' }
  | { type: 'move_down' }
  | { type: 'search'; query: string }
  | { type: 'toggle_sort' }
  | { type: 'select' }
  | { type: 'set_sessions'; sessions: SessionMetadata[] };

export function resumePickerReducer(state: ResumePickerState, action: ResumePickerAction): ResumePickerState {
  switch (action.type) {
    case 'open': {
      const filtered = filterSessions(state.sessions, '', state.sortBy);
      return { ...state, active: true, selectedRow: 0, searchQuery: '', filtered };
    }
    case 'close':
      return { ...state, active: false };
    case 'move_up':
      return { ...state, selectedRow: Math.max(0, state.selectedRow - 1) };
    case 'move_down': {
      const max = Math.max(0, state.filtered.length - 1);
      return { ...state, selectedRow: Math.min(max, state.selectedRow + 1) };
    }
    case 'search': {
      const filtered = filterSessions(state.sessions, action.query, state.sortBy);
      return { ...state, searchQuery: action.query, filtered, selectedRow: 0 };
    }
    case 'toggle_sort': {
      const sortBy: ResumeSortField = state.sortBy === 'updated' ? 'created' : 'updated';
      const filtered = filterSessions(state.sessions, state.searchQuery, sortBy);
      return { ...state, sortBy, filtered, selectedRow: 0 };
    }
    case 'select':
      return state;
    case 'set_sessions': {
      const filtered = filterSessions(action.sessions, state.searchQuery, state.sortBy);
      return { ...state, sessions: action.sessions, filtered };
    }
  }
}

function filterSessions(sessions: SessionMetadata[], query: string, sortBy: ResumeSortField): SessionMetadata[] {
  let result = [...sessions];
  if (query.trim()) {
    const lower = query.toLowerCase();
    result = result.filter(
      (s) =>
        s.title?.toLowerCase().includes(lower) ||
        s.summary?.toLowerCase().includes(lower) ||
        s.branch?.toLowerCase().includes(lower) ||
        s.activeProvider?.toLowerCase().includes(lower) ||
        s.activeModel?.toLowerCase().includes(lower) ||
        s.id.toLowerCase().includes(lower),
    );
  }
  result.sort((a, b) => {
    if (sortBy === 'created') return b.createdAt.localeCompare(a.createdAt);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return result.slice(0, 100);
}

// ─── ANSI helpers ───────────────────────────────────────────

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}
function bright(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

// ─── Renderer ───────────────────────────────────────────────

export function renderResumePicker(state: ResumePickerState, width: number, height: number): string[] {
  if (!state.active) return [];

  const cardW = Math.max(54, Math.min(width - 4, 100));
  const innerW = cardW - 2;
  const cardH = Math.max(10, Math.min(height - 6, 30));

  // ── Fixed column widths ───────────────────────────────────
  const dateW = 7; // "3m ago"
  const msgW = 3;
  const statusW = 9; // "cancelled"
  const branchW = 6;
  const modelW = 12; // truncated with …
  const headRowH = 1; // column header row
  const listH = Math.max(3, cardH - headRowH - 7); // rows for sessions

  const scrollOffset = Math.max(0, state.selectedRow - Math.floor(listH / 2));
  const visibleSlice = state.filtered.slice(scrollOffset, scrollOffset + listH);

  const lines: string[] = [];

  // ── Top border ────────────────────────────────────────────
  lines.push(borderLine('top', cardW));

  // ── Header ────────────────────────────────────────────────
  const title = 'Resume Previous Session';
  const sortLabel = `Sort: ${state.sortBy === 'updated' ? 'Updated' : 'Created'}`;
  const headerPad = Math.max(1, innerW - visibleLen(title) - visibleLen(sortLabel) - 1);
  lines.push(frameLine(` ${bright(title)}${' '.repeat(headerPad)}${dim(sortLabel)}`, cardW));

  // ── Blank separator ───────────────────────────────────────
  lines.push(frameLine('', cardW));

  // ── Search ────────────────────────────────────────────────
  const searchText = state.searchQuery ? `Search: ${state.searchQuery}` : 'Type to search';
  lines.push(frameLine(`  ${searchText}`, cardW));

  // ── Divider ───────────────────────────────────────────────
  lines.push(borderLine('middle', cardW));

  // ── Column headers (dimmed) ───────────────────────────────
  // Dynamically compute title width from remaining space.
  const hasBranch = state.filtered.some((s) => s.branch);
  const hasModel = state.filtered.some((s) => s.activeModel);
  const colGap = '  ';
  const createdHd = 'Created'.padEnd(dateW);
  const updatedHd = 'Updated'.padEnd(dateW);
  const msgsHd = 'Msg'.padStart(msgW);
  const statusHd = 'Status'.padEnd(statusW);
  const hdrParts = [createdHd, updatedHd, msgsHd, statusHd];
  if (hasBranch) hdrParts.push('Branch'.padEnd(branchW));
  if (hasModel) hdrParts.push('Model'.padEnd(modelW));
  const fixedHdr = hdrParts.join(colGap);
  const titleW = Math.max(8, innerW - 3 - visibleLen(fixedHdr) - visibleLen(colGap));
  hdrParts.push('Conversation'.slice(0, titleW).padEnd(titleW));
  lines.push(frameLine(` ${dim(hdrParts.join(colGap))}`, cardW));

  // ── Session rows ──────────────────────────────────────────
  if (state.filtered.length === 0) {
    lines.push(frameLine('', cardW));
    lines.push(frameLine('  No sessions found.', cardW));
  } else {
    for (let i = 0; i < listH; i += 1) {
      const rowIdx = scrollOffset + i;
      const session = visibleSlice[i];
      const isSelected = rowIdx === state.selectedRow;

      if (!session) {
        lines.push(frameLine('', cardW));
        continue;
      }

      const created = fmtRel(session.createdAt).padEnd(dateW);
      const updated = fmtRel(session.updatedAt).padEnd(dateW);
      const msgs = String(session.messageCount ?? 0).padStart(msgW);
      const status = (session.status || 'active').slice(0, statusW).padEnd(statusW);
      const branchVal = hasBranch ? truncate(session.branch || '—', branchW).padEnd(branchW) : '';
      const modelVal = hasModel ? truncate(session.activeModel || '', modelW).padEnd(modelW) : '';
      const convTitle = truncate(session.title || session.summary || session.id, titleW).padEnd(titleW);
      const rowParts = [created, updated, msgs, status];
      if (hasBranch) rowParts.push(branchVal);
      if (hasModel) rowParts.push(modelVal);
      rowParts.push(convTitle);
      const body = rowParts.join(colGap);
      const prefix = isSelected ? '→ ' : '  ';
      const inner = `${prefix}${body}`;
      lines.push(frameLine(inner, cardW));
    }
  }

  // ── Fill remaining rows ───────────────────────────────────
  for (let i = visibleSlice.length; i < listH; i += 1) {
    lines.push(frameLine('', cardW));
  }

  // ── Bottom border ─────────────────────────────────────────
  lines.push(borderLine('bottom', cardW));

  // ── Footer hint (below the border) ────────────────────────
  const footer = 'Enter resume · Tab sort · Type search · Esc close';
  const footerPlain = footer;
  const fullW = cardW + 2; // match the border-line width
  const footerPad = Math.max(0, Math.floor((fullW - footerPlain.length) / 2));
  lines.push(
    `${' '.repeat(footerPad)}${dim(footer)}${' '.repeat(Math.max(0, fullW - footerPad - footerPlain.length))}`,
  );

  return lines;
}

// ─── Helpers ────────────────────────────────────────────────

function fmtRel(isoDate: string): string {
  try {
    const now = Date.now();
    const then = new Date(isoDate).getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return 'now';
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(isoDate).toLocaleDateString();
  } catch {
    return isoDate.slice(5, 10);
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function borderLine(kind: 'top' | 'middle' | 'bottom', width: number): string {
  const [left, right] = kind === 'top' ? ['┌', '┐'] : kind === 'bottom' ? ['└', '┘'] : ['├', '┤'];
  return `${left}${'─'.repeat(width)}${right}`;
}

function frameLine(content: string, width: number): string {
  const plain = content.replace(ANSI_RE, '');
  const pad = Math.max(0, width - plain.length);
  return `│${content}${' '.repeat(pad)}│`;
}
