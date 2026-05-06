export interface ParsedInput {
  type: 'text' | 'submit' | 'backspace' | 'exit' | 'redraw' | 'scroll_history_up' | 'scroll_history_down';
  value?: string;
}

export function parseInputChunk(chunk: string): ParsedInput[] {
  const events: ParsedInput[] = [];
  for (let index = 0; index < chunk.length; index += 1) {
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
    const char = chunk[index];
    if (char === '\u0003') {
      events.push({ type: 'exit' });
      continue;
    }
    if (char === '\u000c') {
      events.push({ type: 'redraw' });
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
    events.push({ type: 'text', value: char });
  }
  return events;
}
