/**
 * Keyboard input for Synax Backrooms.
 *
 * Parses raw stdin data into game actions.
 * Handles WASD, arrow keys, Q/Esc exit, L overlay, H help, 1/2/3 level switch (debug),
 * Enter interact.
 */
import type { InputStreamLike } from './types';

export type BackroomsAction =
  | 'move_forward'
  | 'move_back'
  | 'strafe_left'
  | 'strafe_right'
  | 'turn_left'
  | 'turn_right'
  | 'toggle_overlay'
  | 'toggle_help'
  | 'interact'
  | 'level_1'
  | 'level_2'
  | 'level_3'
  | 'exit';

export interface BackroomsInput {
  /** Install data listener on stdin. */
  attach(stdin: InputStreamLike, onAction: (action: BackroomsAction) => void): void;
  /** Remove data listener from stdin. */
  detach(stdin: InputStreamLike): void;
}

export function createBackroomsInput(): BackroomsInput {
  let listener: ((chunk: Buffer) => void) | null = null;

  return {
    attach(stdin: InputStreamLike, onAction: (action: BackroomsAction) => void): void {
      listener = (chunk: Buffer): void => {
        const actions = parseBackroomsInput(chunk.toString('utf8'));
        for (const action of actions) {
          onAction(action);
        }
      };
      stdin.on('data', listener);
    },
    detach(stdin: InputStreamLike): void {
      if (listener) {
        stdin.off('data', listener);
        listener = null;
      }
    },
  };
}

export function parseBackroomsInput(chunk: string): BackroomsAction[] {
  const actions: BackroomsAction[] = [];

  for (let i = 0; i < chunk.length; i += 1) {
    const char = chunk[i];

    // Ctrl+C → exit
    if (char === '\u0003') {
      actions.push('exit');
      continue;
    }

    // Escape sequences
    if (char === '\x1b') {
      if (chunk[i + 1] === '[') {
        const seq = chunk.slice(i, i + 3);
        if (seq === '\x1b[A') {
          actions.push('move_forward');
          i += 2;
        } else if (seq === '\x1b[B') {
          actions.push('move_back');
          i += 2;
        } else if (seq === '\x1b[C') {
          actions.push('turn_right');
          i += 2;
        } else if (seq === '\x1b[D') {
          actions.push('turn_left');
          i += 2;
        }
        // Other escape sequences are ignored
        continue;
      }
      // Bare ESC → exit
      actions.push('exit');
      continue;
    }

    // Regular characters (case-sensitive for WASD)
    switch (char) {
      case 'w':
      case 'W':
        actions.push('move_forward');
        break;
      case 's':
      case 'S':
        actions.push('move_back');
        break;
      case 'a':
      case 'A':
        actions.push('strafe_left');
        break;
      case 'd':
      case 'D':
        actions.push('strafe_right');
        break;
      case 'q':
      case 'Q':
        actions.push('exit');
        break;
      case 'l':
      case 'L':
        actions.push('toggle_overlay');
        break;
      case 'h':
      case 'H':
        actions.push('toggle_help');
        break;
      case '\r':
      case '\n':
        actions.push('interact');
        break;
      case '1':
        actions.push('level_1');
        break;
      case '2':
        actions.push('level_2');
        break;
      case '3':
        actions.push('level_3');
        break;
      // All other keys ignored
    }
  }

  return actions;
}
