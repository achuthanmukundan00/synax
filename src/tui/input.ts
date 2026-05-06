export interface ParsedInput {
  type: 'text' | 'submit' | 'backspace' | 'exit' | 'redraw';
  value?: string;
}

export function parseInputChunk(chunk: string): ParsedInput[] {
  const events: ParsedInput[] = [];
  for (const char of chunk) {
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
