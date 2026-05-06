const ESC = '\u001b[';

export class DiffRenderer {
  private previous: string[] = [];
  private width = 0;
  private height = 0;

  render(lines: string[], width: number, height: number): string {
    const next = lines.slice(0, height).map((line) => clip(line, width));
    const sizeChanged = width !== this.width || height !== this.height;
    this.width = width;
    this.height = height;

    if (sizeChanged || this.previous.length === 0) {
      this.previous = next;
      return `${ESC}H\u001b[2J${next.map((line, i) => `${ESC}${i + 1};1H${line}`).join('')}`;
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
      chunks.push(`${ESC}${i + 1};1H${next[i]}`);
    }
    this.previous = next;
    return chunks.join('');
  }
}

function clip(line: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = line.replace(/\u001b\[[0-9;]*m/g, '');
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
