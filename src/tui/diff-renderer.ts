import { charWidthAt, visibleLength, closeAnsi, terminalWriteWidth } from './text-utils';

const CSI = '[';

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
      return `${CSI}H[2J${next.map((line, i) => renderLine(i, line)).join('')}`;
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
  return `${CSI}${index + 1};1H[0m[2K${line}[0m`;
}

function clip(line: string, width: number): string {
  if (visibleLength(line) <= width) return closeAnsi(line);
  let visibleCount = 0;
  let out = '';
  for (let i = 0; i < line.length; ) {
    if (line[i] === '') {
      // eslint-disable-next-line no-control-regex
      const match = /\[[0-9;]*[a-zA-Z]/.exec(line.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    const [w, advance] = charWidthAt(line, i);
    if (visibleCount + w > width) break;
    out += line.slice(i, i + advance);
    visibleCount += w;
    i += advance;
  }
  return closeAnsi(out);
}
