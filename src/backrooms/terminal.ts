/**
 * Terminal control for Synax Backrooms.
 *
 * Manages alternate screen, raw mode, cursor visibility, and cleanup.
 * Designed to be testable with injectable stdin/stdout.
 */
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import type { Writable } from 'node:stream';
import type { InputStreamLike } from './types';

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const ALT_SCREEN = '\u001b[?1049h';
const MAIN_SCREEN = '\u001b[?1049l';
const CLEAR = '\u001b[2J';
const HOME = '\u001b[H';
const SYNC_START = '\u001b[?2026h';
const SYNC_END = '\u001b[?2026l';

export interface BackroomsTerminal {
  readonly columns: number;
  readonly rows: number;
  start(): void;
  stop(): void;
  write(text: string): void;
  home(): void;
  clear(): void;
  flush(): void;
}

export function createBackroomsTerminal(streams?: {
  stdin?: InputStreamLike;
  stdout?: Writable & { isTTY?: boolean; columns?: number; rows?: number };
}): BackroomsTerminal {
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
    start(): void {
      if (!isTTY) return;
      stdin.setRawMode?.(true);
      stdin.resume();
      stdout.write(`${ALT_SCREEN}${HIDE_CURSOR}${CLEAR}${HOME}`);
    },
    stop(): void {
      if (!isTTY) return;
      stdout.write(`${SHOW_CURSOR}${MAIN_SCREEN}`);
      stdin.setRawMode?.(false);
      stdin.pause();
    },
    write(text: string): void {
      stdout.write(`${SYNC_START}${text}${SYNC_END}`);
    },
    home(): void {
      stdout.write(HOME);
    },
    clear(): void {
      stdout.write(`${HOME}${CLEAR}`);
    },
    flush(): void {
      // no-op: stdout is unbuffered
    },
  };
}
