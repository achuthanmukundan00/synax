export interface ParsedInput {
  type: 'text' | 'submit' | 'backspace' | 'exit' | 'scroll_history_up' | 'scroll_history_down';
  value?: string;
}

export const MAX_INPUT_CHARS = 4096;

export function parseInputChunk(chunk: string): ParsedInput[] {
  const events: ParsedInput[] = [];
  for (let index = 0; index < chunk.length; index += 1) {
    const mouse = parseSgrMouse(chunk, index);
    if (mouse) {
      if (mouse.button === 64) events.push({ type: 'scroll_history_up' });
      if (mouse.button === 65) events.push({ type: 'scroll_history_down' });
      index += mouse.length - 1;
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
