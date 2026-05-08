const ESC = '\u001b[';

export class DiffRenderer {
  private previous: string[] = [];
  private width = 0;
  private height = 0;

  reset(): void {
    this.previous = [];
    this.width = 0;
    this.height = 0;
  }

  render(lines: string[], width: number, height: number): string {
    const writeWidth = terminalWriteWidth(width);
    const next = Array.from({ length: height }, (_, index) => clip(lines[index] ?? '', writeWidth));
    const sizeChanged = width !== this.width || height !== this.height;
    this.width = width;
    this.height = height;

    if (sizeChanged || this.previous.length === 0) {
      this.previous = next;
      return `${ESC}H\u001b[2J${next.map((line, i) => renderLine(i, line)).join('')}`;
    }

    let firstChanged = -1;
    for (let i = 0; i < next.length; i += 1) {
      if (next[i] !== (this.previous[i] ?? '')) {
        firstChanged = i;
        break;
      }
    }
    if (firstChanged < 0) return '';

    const chunks: string[] = [];
    for (let i = firstChanged; i < next.length; i += 1) {
      if (next[i] === (this.previous[i] ?? '')) continue;
      chunks.push(renderLine(i, next[i]));
    }
    this.previous = next;
    return chunks.join('');
  }
}

function renderLine(index: number, line: string): string {
  return `${ESC}${index + 1};1H\u001b[0m\u001b[2K${line}\u001b[0m`;
}

function clip(line: string, width: number): string {
  const visible = stripAnsi(line);
  if (visible.length <= width) return line;

  let visibleCount = 0;
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\u001b') {
      // eslint-disable-next-line no-control-regex
      const match = /\u001b\[[0-9;]*m/.exec(line.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }

    if (visibleCount >= width) break;
    out += line[i];
    visibleCount += 1;
  }

  return out;
}

function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;]*m/g, '');
}

function terminalWriteWidth(width: number): number {
  return width > 1 ? width - 1 : width;
}
