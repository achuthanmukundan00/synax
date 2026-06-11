/**
 * Resume session picker state and renderer.
 *
 * Keyboard-navigable session picker for /resume command.
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

// ─── Renderer ───────────────────────────────────────────────

export function renderResumePicker(state: ResumePickerState, width: number, height: number): string[] {
  if (!state.active) return [];

  const innerW = Math.max(50, Math.min(width - 4, 100));
  const innerH = Math.max(10, Math.min(height - 4, 30));
  const visibleRows = Math.max(1, innerH - 6); // header + sort + search + footer
  const scrollOffset = Math.max(0, state.selectedRow - Math.floor(visibleRows / 2));
  const visibleSlice = state.filtered.slice(scrollOffset, scrollOffset + visibleRows);

  const lines: string[] = [];

  // Header
  const sortLabel = `Sort: ${state.sortBy === 'updated' ? 'Updated' : 'Created'}`;
  const headerLabel = 'Resume Previous Session';
  const headerPad = Math.max(0, innerW - headerLabel.length - sortLabel.length - 2);
  lines.push(borderLine('top', innerW));
  lines.push(frameLine(` ${headerLabel}${' '.repeat(headerPad)}${sortLabel} `, innerW));

  // Search
  const searchLabel = state.searchQuery ? `Type to search: ${state.searchQuery}_` : 'Type to search';
  lines.push(frameLine(` ${searchLabel} `, innerW));
  lines.push(borderLine('middle', innerW));

  // Column headers
  const colHeader = '  Created        Updated        Msgs Status     Branch      Model       Conversation';
  lines.push(frameLine(colHeader, innerW));

  // Sessions
  if (state.filtered.length === 0) {
    lines.push(frameLine('', innerW));
    lines.push(frameLine('  No sessions found', innerW));
  } else {
    for (let i = 0; i < visibleRows; i += 1) {
      const rowIdx = scrollOffset + i;
      const session = visibleSlice[i];
      const isSelected = rowIdx === state.selectedRow;

      if (!session) {
        lines.push(frameLine('', innerW));
        continue;
      }

      const prefix = isSelected ? '> ' : '  ';
      const created = formatRelative(session.createdAt);
      const updated = formatRelative(session.updatedAt);
      const branch = session.branch || '—';
      const status = session.status || 'active';
      const messageCount = String(session.messageCount ?? 0);
      const model = session.activeModel || '—';
      const title = session.title || session.summary || session.id;

      const rowContent = `${prefix}${created.padEnd(14)} ${updated.padEnd(14)} ${messageCount.padStart(4)} ${status
        .slice(0, 10)
        .padEnd(10)} ${branch.slice(0, 10).padEnd(10)} ${model.slice(0, 11).padEnd(11)} ${title}`;

      lines.push(frameLine(rowContent, innerW));
    }
  }

  // Fill remaining rows
  for (let i = visibleSlice.length; i < visibleRows; i += 1) {
    lines.push(frameLine('', innerW));
  }

  // Footer
  const footer = ' enter to resume    esc close    ctrl+d quit    tab sort    up/down browse ';
  lines.push(borderLine('bottom', innerW, footer));

  return lines;
}

// ─── Helpers ────────────────────────────────────────────────

function formatRelative(isoDate: string): string {
  try {
    const now = Date.now();
    const then = new Date(isoDate).getTime();
    const diffMs = now - then;

    if (diffMs < 60_000) return 'just now';
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
    return new Date(isoDate).toLocaleDateString();
  } catch {
    return isoDate;
  }
}

function borderLine(kind: 'top' | 'middle' | 'bottom', width: number, label = ''): string {
  const left = kind === 'bottom' ? '+' : '+';
  const right = kind === 'bottom' ? '+' : '+';
  if (!label) return `${left}${'-'.repeat(width)}${right}`;
  const clipped = clipToWidth(label, width);
  return `${left}${clipped}${'-'.repeat(Math.max(0, width - clipped.length))}${right}`;
}

function frameLine(content: string, width: number): string {
  const clipped = clipToWidth(content, width);
  return `|${clipped}${' '.repeat(Math.max(0, width - clipped.length))}|`;
}

function clipToWidth(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}
