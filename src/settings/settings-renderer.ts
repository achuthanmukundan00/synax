/**
 * Settings menu terminal renderer.
 *
 * Renders the settings modal as terminal lines. Uses Synax's industrial
 * style: aligned labels, subtle separators, muted inactive text, strong
 * active-row marker, grey disabled controls, masked secrets.
 */
import type { SettingsState, SettingsTab } from './settings-state';
import { SETTINGS_TABS, getTabRows, tabLabel } from './settings-state';

// ─── Public API ─────────────────────────────────────────────

export function renderSettings(state: SettingsState, width: number, height: number): string[] {
  if (!state.active) return [];

  const innerW = Math.max(50, Math.min(width - 4, 100));
  const innerH = Math.max(12, Math.min(height - 4, 36));
  const rows = getTabRows(state.tab, state.config);
  const visibleRows = Math.max(1, innerH - 5); // header + tabs + footer
  const scrollOffset = Math.max(0, state.selectedRow - Math.floor(visibleRows / 2));
  const visibleSlice = rows.slice(scrollOffset, scrollOffset + visibleRows);

  const lines: string[] = [];

  // Modal frame top
  lines.push(dim(`┌${'─'.repeat(innerW)}┐`));

  // Title
  const title = ' Settings ';
  const tabBar = renderTabBar(state.tab, innerW - title.length);
  lines.push(`${dim('│')}${bold(title)}${tabBar}${dim('│')}`);

  // Separator
  lines.push(`${dim('│')}${dim('─'.repeat(innerW))}${dim('│')}`);

  // Content rows
  for (let i = 0; i < visibleRows; i += 1) {
    const rowIdx = scrollOffset + i;
    const row = visibleSlice[i];
    const isSelected = rowIdx === state.selectedRow && state.focus === 'rows';

    if (!row) {
      lines.push(`${dim('│')}${' '.repeat(innerW)}${dim('│')}`);
      continue;
    }

    let rowText: string;
    if (row.kind === 'info' && row.dimmed) {
      rowText = dim(renderHeaderRow(row.label, row.value, innerW, isSelected));
    } else if (row.kind === 'info') {
      rowText = renderHeaderRow(row.label, row.value, innerW, isSelected);
    } else if (row.kind === 'toggle') {
      rowText = renderToggleRow(row, innerW, isSelected, state);
    } else if (row.kind === 'select') {
      rowText = renderSelectRow(row, innerW, isSelected, state);
    } else if (row.kind === 'editable') {
      rowText = renderEditableRow(row, innerW, isSelected, state);
    } else {
      rowText = renderInfoRow(row.label, row.value, innerW, isSelected);
    }

    lines.push(`${dim('│')}${rowText}${dim('│')}`);
  }

  // Footer
  lines.push(`${dim('│')}${' '.repeat(innerW)}${dim('│')}`);
  const footer = ' Enter select · Tab tabs · Esc close ';
  const footerPad = Math.max(0, innerW - footer.length);
  lines.push(`${dim('└')}${footer}${'─'.repeat(footerPad)}${dim('┘')}`);

  return lines;
}

// ─── Tab bar ────────────────────────────────────────────────

function renderTabBar(active: SettingsTab, width: number): string {
  let result = '';
  for (const tab of SETTINGS_TABS) {
    const label = tabLabel(tab);
    if (tab === active) {
      result += ` ${invert(label)} `;
    } else {
      result += ` ${dim(label)} `;
    }
    result += dim('|');
  }
  // Remove trailing separator
  result = result.slice(0, -1);

  // Pad to width
  const visible = stripAnsi(result).length;
  if (visible < width) {
    result += ' '.repeat(width - visible);
  }
  return result;
}

// ─── Row renderers ──────────────────────────────────────────

function renderHeaderRow(label: string, value: string, width: number, selected: boolean): string {
  const prefix = selected ? '→ ' : '  ';
  const labelStr = label ? `${bold(label)}` : '';
  const valueStr = value ? `  ${dim(value)}` : '';
  const content = `${prefix}${labelStr}${valueStr}`;
  return padRight(content, width);
}

function renderInfoRow(label: string, value: string, width: number, selected: boolean): string {
  const prefix = selected ? '→ ' : '  ';
  const content = `${prefix}${label}${value ? `  ${dim(value)}` : ''}`;
  return padRight(content, width);
}

function renderToggleRow(
  row: { id: string; label: string; value: string; enabled?: boolean },
  width: number,
  selected: boolean,
  _state: SettingsState,
): string {
  const prefix = selected ? '→ ' : '  ';
  const check = row.enabled ? green('✓') : dim('○');
  const labelStr = row.label.replace(/^[✓○!]\s*/, '');
  const content = `${prefix}${check} ${labelStr}`;
  const valueStr = row.value ? `  ${dim(row.value)}` : '';
  return padRight(`${content}${valueStr}`, width);
}

function renderSelectRow(
  row: { id: string; label: string; value: string; enabled?: boolean; dimmed?: boolean },
  width: number,
  selected: boolean,
  _state: SettingsState,
): string {
  const prefix = selected ? '→ ' : '  ';
  if (row.dimmed) {
    return padRight(`${prefix}${dim(row.label)}  ${dim(row.value)}`, width);
  }
  return padRight(`${prefix}${row.label}  ${dim(row.value)}`, width);
}

function renderEditableRow(
  row: { id: string; label: string; value: string },
  width: number,
  selected: boolean,
  state: SettingsState,
): string {
  const prefix = selected ? '→ ' : '  ';
  const textInput = state.textInput;

  if (textInput && textInput.rowId === row.id) {
    // In edit mode: show cursor
    const cursor = textInput.cursor;
    const before = textInput.value.slice(0, cursor);
    const at = textInput.value[cursor] || ' ';
    const after = textInput.value.slice(cursor + 1);
    const displayValue = `${dim(before)}${invert(at)}${dim(after)}`;
    return padRight(`${prefix}${row.label}: ${displayValue}`, width);
  }

  return padRight(`${prefix}${row.label}: ${dim(row.value)}`, width);
}

// ─── Helpers ────────────────────────────────────────────────

function bold(text: string): string {
  return `\u001b[1;37m${text}\u001b[0m`;
}

function dim(text: string): string {
  return `\u001b[90m${text}\u001b[0m`;
}

function green(text: string): string {
  return `\u001b[32m${text}\u001b[0m`;
}

function invert(text: string): string {
  return `\u001b[7m${text}\u001b[0m`;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function padRight(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  return text + ' '.repeat(width - visible);
}
