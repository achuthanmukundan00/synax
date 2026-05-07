export interface ParsedInput {
  type:
    | 'text'
    | 'submit'
    | 'backspace'
    | 'exit'
    | 'scroll_history_up'
    | 'scroll_history_down'
    | 'paste'
    | 'arrow_up'
    | 'arrow_down'
    | 'escape'
    | 'tab'
    | 'shift_tab';
  value?: string;
}

export const MAX_INPUT_CHARS = 4096;

export function parseInputChunk(chunk: string): ParsedInput[] {
  const events: ParsedInput[] = [];
  let pasteMode = false;
  let pasteText = '';

  for (let index = 0; index < chunk.length; index += 1) {
    // Paste bracket handling: absorb everything between bracket-paste start/end
    // without treating newlines as submit or backspaces as backspace.
    if (pasteMode) {
      if (chunk.startsWith('\x1b[201~', index)) {
        pasteMode = false;
        events.push({ type: 'paste', value: pasteText });
        pasteText = '';
        index += 5;
        continue;
      }
      if (chunk[index] === '\u0003') {
        pasteMode = false;
        events.push({ type: 'exit' });
        pasteText = '';
        continue;
      }
      pasteText += chunk[index];
      continue;
    }

    if (chunk.startsWith('\x1b[200~', index)) {
      pasteMode = true;
      pasteText = '';
      index += 5;
      continue;
    }

    const mouse = parseSgrMouse(chunk, index);
    if (mouse) {
      if (mouse.button === 64) events.push({ type: 'scroll_history_up' });
      if (mouse.button === 65) events.push({ type: 'scroll_history_down' });
      index += mouse.length - 1;
      continue;
    }
    // Arrow keys
    if (chunk.startsWith('\x1b[A', index)) {
      events.push({ type: 'arrow_up' });
      index += 2;
      continue;
    }
    if (chunk.startsWith('\x1b[B', index)) {
      events.push({ type: 'arrow_down' });
      index += 2;
      continue;
    }
    if (chunk.startsWith('\x1b[C', index)) {
      // Right arrow is intentionally ignored; settings tabs use Tab.
      index += 2;
      continue;
    }
    if (chunk.startsWith('\x1b[D', index)) {
      // Left arrow is intentionally ignored; settings tabs use Shift+Tab.
      index += 2;
      continue;
    }
    // Escape
    if (chunk.startsWith('\x1b', index) && chunk.length === index + 1) {
      events.push({ type: 'escape' });
      continue;
    }
    if (chunk.startsWith('\x1b\x1b', index)) {
      events.push({ type: 'escape' });
      index += 1;
      continue;
    }
    // Tab / Shift+Tab
    if (chunk.startsWith('\x1b[Z', index)) {
      events.push({ type: 'shift_tab' });
      index += 3;
      continue;
    }
    if (chunk.startsWith('\t', index)) {
      events.push({ type: 'tab' });
      continue;
    }

    if (chunk.startsWith('\x1b[5~', index)) {
      events.push({ type: 'scroll_history_up' });
      index += 3;
      continue;
    }
    if (chunk.startsWith('\x1b[6~', index)) {
      events.push({ type: 'scroll_history_down' });
      index += 3;
      continue;
    }
    const escapeLength = parseUnsupportedEscapeLength(chunk, index);
    if (escapeLength > 0) {
      index += escapeLength - 1;
      continue;
    }
    const char = chunk[index];
    if (char === '\u000c') {
      continue;
    }
    if (char === '\u0003') {
      events.push({ type: 'exit' });
      continue;
    }
    if (char === '\u007f' || char === '\b') {
      events.push({ type: 'backspace' });
      continue;
    }
    if (char === '\r' || char === '\n') {
      events.push({ type: 'submit' });
      continue;
    }
    if (isUnsupportedControlCharacter(char)) {
      continue;
    }
    events.push({ type: 'text', value: char });
  }

  // If paste brackets were unmatched (e.g., terminal crash), flush remainder as text.
  if (pasteMode && pasteText.length > 0) {
    events.push({ type: 'paste', value: pasteText });
  }

  return events;
}

function parseSgrMouse(chunk: string, index: number): { button: number; length: number } | undefined {
  // eslint-disable-next-line no-control-regex
  const match = /^\x1b\[<(\d+);\d+;\d+[mM]/.exec(chunk.slice(index));
  if (!match) return undefined;
  return { button: Number(match[1]), length: match[0].length };
}

function parseUnsupportedEscapeLength(chunk: string, index: number): number {
  if (chunk[index] !== '\x1b') return 0;

  const rest = chunk.slice(index);
  const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(rest);
  if (csi) return csi[0].length;

  const ss3 = /^\x1bO[ -~]/.exec(rest);
  if (ss3) return ss3[0].length;

  if (rest.startsWith('\x1b[') || rest.startsWith('\x1bO')) return rest.length;

  return 1;
}

function isUnsupportedControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 32 || (code >= 127 && code <= 159);
}
