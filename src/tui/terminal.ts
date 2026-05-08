import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import type { Writable } from 'node:stream';

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const RESET_CURSOR_STYLE = '\u001b[0 q';
const ALT_SCREEN = '\u001b[?1049h';
const MAIN_SCREEN = '\u001b[?1049l';
const CLEAR = '\u001b[2J';
const HOME = '\u001b[H';
const SYNC_START = '\u001b[?2026h';
const SYNC_END = '\u001b[?2026l';
const ENABLE_MOUSE = '\u001b[?1000h\u001b[?1006h';
const DISABLE_MOUSE = '\u001b[?1006l\u001b[?1000l';
const ENABLE_BRACKETED_PASTE = '\u001b[?2004h';
const DISABLE_BRACKETED_PASTE = '\u001b[?2004l';

export interface InputStreamLike {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  off(event: 'data', listener: (chunk: Buffer) => void): void;
}

export interface TerminalSessionOptions {
  /** Enable SGR mouse tracking for app-managed wheel scrolling. Default false. */
  enableMouse?: boolean;
  /** Use alternate screen buffer. Default true. */
  alternateScreen?: boolean;
}

export interface TerminalSession {
  readonly columns: number;
  readonly rows: number;
  readonly isTTY: boolean;
  readonly mouseEnabled: boolean;
  readonly alternateScreenEnabled: boolean;
  start(): void;
  stop(): void;
  write(text: string): void;
  synchronizedWrite(text: string): void;
  clearScreen(): void;
  /** Enable SGR mouse tracking at runtime. Idempotent. */
  enableMouse(): void;
  /** Disable SGR mouse tracking at runtime. Idempotent. */
  disableMouse(): void;
}

export function createTerminalSession(
  streams?: {
    stdin?: InputStreamLike;
    stdout?: Writable & { isTTY?: boolean; columns?: number; rows?: number };
  },
  options?: TerminalSessionOptions,
): TerminalSession {
  const stdin = streams?.stdin ?? (defaultStdin as unknown as InputStreamLike);
  const stdout =
    streams?.stdout ?? (defaultStdout as unknown as Writable & { isTTY?: boolean; columns?: number; rows?: number });

  const isTTY = Boolean(stdin.isTTY && stdout.isTTY && stdin.setRawMode);
  let mouseEnabled = options?.enableMouse ?? false;
  const alternateScreenEnabled = options?.alternateScreen ?? true;

  return {
    get columns(): number {
      return stdout.columns ?? 120;
    },
    get rows(): number {
      return stdout.rows ?? 36;
    },
    get isTTY(): boolean {
      return isTTY;
    },
    get mouseEnabled(): boolean {
      return mouseEnabled;
    },
    get alternateScreenEnabled(): boolean {
      return alternateScreenEnabled;
    },
    start(): void {
      if (!isTTY) return;
      stdin.setRawMode?.(true);
      stdin.resume();
      const parts: string[] = [];
      if (alternateScreenEnabled) parts.push(ALT_SCREEN);
      parts.push(HIDE_CURSOR);
      if (mouseEnabled) parts.push(ENABLE_MOUSE);
      parts.push(ENABLE_BRACKETED_PASTE);
      if (alternateScreenEnabled || mouseEnabled) {
        parts.push(CLEAR, HOME);
      }
      stdout.write(parts.join(''));
    },
    stop(): void {
      if (!isTTY) return;
      // Always defensively emit disable sequences — the terminal ignores
      // them if the corresponding mode was never enabled.
      stdout.write(`${DISABLE_BRACKETED_PASTE}${DISABLE_MOUSE}${SHOW_CURSOR}${RESET_CURSOR_STYLE}${MAIN_SCREEN}`);
      stdin.setRawMode?.(false);
      stdin.pause();
    },
    write(text: string): void {
      stdout.write(text);
    },
    synchronizedWrite(text: string): void {
      stdout.write(`${SYNC_START}${text}${SYNC_END}`);
    },
    clearScreen(): void {
      stdout.write(`${HOME}${CLEAR}`);
    },
    enableMouse(): void {
      if (!isTTY || mouseEnabled) return;
      mouseEnabled = true;
      stdout.write(ENABLE_MOUSE);
    },
    disableMouse(): void {
      if (!isTTY || !mouseEnabled) return;
      mouseEnabled = false;
      stdout.write(DISABLE_MOUSE);
    },
  };
}
