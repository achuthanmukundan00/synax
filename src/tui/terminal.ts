import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import type { Writable } from 'node:stream';

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const ALT_SCREEN = '\u001b[?1049h';
const MAIN_SCREEN = '\u001b[?1049l';
const CLEAR = '\u001b[2J';
const HOME = '\u001b[H';
const SYNC_START = '\u001b[?2026h';
const SYNC_END = '\u001b[?2026l';

export interface InputStreamLike {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  off(event: 'data', listener: (chunk: Buffer) => void): void;
}

export interface TerminalSession {
  readonly columns: number;
  readonly rows: number;
  readonly isTTY: boolean;
  start(): void;
  stop(): void;
  write(text: string): void;
  synchronizedWrite(text: string): void;
  clearScreen(): void;
}

export function createTerminalSession(streams?: {
  stdin?: InputStreamLike;
  stdout?: Writable & { isTTY?: boolean; columns?: number; rows?: number };
}): TerminalSession {
  const stdin = streams?.stdin ?? (defaultStdin as unknown as InputStreamLike);
  const stdout =
    streams?.stdout ?? (defaultStdout as unknown as Writable & { isTTY?: boolean; columns?: number; rows?: number });

  const isTTY = Boolean(stdin.isTTY && stdout.isTTY && stdin.setRawMode);

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
    start(): void {
      if (!isTTY) return;
      stdin.setRawMode?.(true);
      stdin.resume();
      stdout.write(`${ALT_SCREEN}${HIDE_CURSOR}${CLEAR}${HOME}\u001b[?2004h`);
    },
    stop(): void {
      if (!isTTY) return;
      stdout.write(`\u001b[?2004l${SHOW_CURSOR}${MAIN_SCREEN}`);
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
  };
}
