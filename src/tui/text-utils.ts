/**
 * Shared terminal text utilities extracted from layout.ts and transcript.ts.
 *
 * These functions are the canonical implementations — every TUI module should
 * import from here rather than reimplementing.
 */

const ESC = String.fromCharCode(27);
const ANSI_CSI_SOURCE = ESC + '\\[[0-9;]*[a-zA-Z]';
/** Non-global pattern for .test() and .exec() — safe across repeated calls. */
const ANSI_CSI = new RegExp(ANSI_CSI_SOURCE);
const RESET = ESC + '[0m';

export function stripAnsi(input: string): string {
  return input.replace(new RegExp(ANSI_CSI_SOURCE, 'g'), '');
}

export function hasAnsi(input: string): boolean {
  return ANSI_CSI.test(input);
}

export function closeAnsi(input: string): string {
  return hasAnsi(input) && !input.endsWith(RESET) ? input + RESET : input;
}

export function terminalWriteWidth(width: number): number {
  return width > 1 ? width - 1 : width;
}

export function padAnsi(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible >= width) return text;
  return `${text}${' '.repeat(width - visible)}`;
}

export function clipAnsi(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  const target = Math.max(0, width - 1);
  let visibleCount = 0;
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === ESC) {
      const match = ANSI_CSI.exec(text.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    const [w, advance] = charWidthAt(text, i);
    if (visibleCount + w > target) break;
    out += text.slice(i, i + advance);
    visibleCount += w;
    i += advance;
  }
  return `${out}…`;
}

/**
 * Calculate the visual (display) width of a string in a terminal.
 * Accounts for CJK ideographs, fullwidth forms, emoji, and other
 * characters that occupy two column positions.
 */
export function visibleLength(input: string): number {
  let len = 0;
  let i = 0;
  while (i < input.length) {
    const [w, advance] = charWidthAt(input, i);
    len += w;
    i += advance;
  }
  return len;
}

function isSurrogateLead(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isSurrogateTrail(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Terminal display width for a Unicode code point. */
function charDisplayWidth(cp: number): number {
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) return 2;
  if (cp >= 0xf900 && cp <= 0xfaff) return 2;
  if (cp >= 0x2e80 && cp <= 0x2fdf) return 2;
  if (cp >= 0x2ff0 && cp <= 0x2fff) return 2;
  if ((cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) return 2;
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2;
  if ((cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2300 && cp <= 0x23ff)) return 2;
  if (cp >= 0x1f000) return 2;
  if (cp >= 0x20000 && cp <= 0x3ffff) return 2;
  return 1;
}

/**
 * Wrap text into lines that fit within `width` visible columns.
 * Splits on word boundaries where possible; fallback to character-level
 * break when a single word exceeds the width.
 */
export function wordWrapLines(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(' ');
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (visibleLength(test) <= width) {
        current = test;
      } else {
        if (current) {
          lines.push(current);
          current = '';
        }
        // Word longer than width: break character-by-character.
        let remaining = word;
        while (visibleLength(remaining) > width) {
          // Chop front of `remaining` into a line that fits.
          let fit = '';
          let vi = 0;
          for (let ci = 0; ci < remaining.length; ) {
            const [cw, adv] = charWidthAt(remaining, ci);
            if (vi + cw > width) break;
            fit += remaining.slice(ci, ci + adv);
            vi += cw;
            ci += adv;
          }
          lines.push(fit || remaining.slice(0, 1));
          remaining = remaining.slice(fit.length);
        }
        current = remaining;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export function charWidthAt(text: string, i: number): [number, number] {
  const code = text.charCodeAt(i);
  if (code === 0x1b) {
    const match = ANSI_CSI.exec(text.slice(i));
    if (match) return [0, match[0].length];
  }
  if (isSurrogateLead(code) && i + 1 < text.length && isSurrogateTrail(text.charCodeAt(i + 1))) {
    const hi = code;
    const lo = text.charCodeAt(i + 1);
    const cp = ((hi & 0x3ff) << 10) | ((lo & 0x3ff) + 0x10000);
    return [charDisplayWidth(cp), 2];
  }
  if (isSurrogateTrail(code)) {
    return [1, 1];
  }
  return [charDisplayWidth(code), 1];
}
