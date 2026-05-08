/** Types for Synax Backrooms — hidden terminal exploration mode. */

import type { Writable } from 'node:stream';

export interface InputStreamLike {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  off(event: 'data', listener: (chunk: Buffer) => void): void;
}

export interface BackroomsOptions {
  /** Enable debug mode (allows 1/2/3 level switching, extra info). */
  debug?: boolean;
  /** Lower frame rate for power saving. */
  lowPower?: boolean;
  /** Target frames per second. Default 60. */
  fps?: number;
  /** Injectable stdin for testing. */
  stdin?: InputStreamLike;
  /** Injectable stdout for testing. */
  stdout?: Writable & { isTTY?: boolean; columns?: number; rows?: number };
}

export interface Point {
  x: number;
  y: number;
}

export interface WallDef {
  /** Wall type id in the map grid. */
  id: number;
  /** Truecolor RGB for this wall type. */
  color: [number, number, number];
  /** Visual character/glyph to use (empty string = use default). */
  glyph?: string;
}

export interface TextFragment {
  text: string;
  /** Grid position. */
  x: number;
  y: number;
  /** How close the player must be (in grid cells) to trigger display. */
  triggerRadius: number;
}

export interface LevelDef {
  name: string;
  /** Square 2D grid: 0 = empty walkable space, non-zero = wall id. */
  map: number[][];
  /** Player spawn position (grid coordinates). */
  playerStart: Point;
  /** Player initial facing angle in radians. */
  playerAngle: number;
  /** Wall type definitions keyed by map cell value. */
  walls: WallDef[];
  /** Floor truecolor RGB. */
  floorColor: [number, number, number];
  /** Ceiling truecolor RGB. */
  ceilingColor: [number, number, number];
  /** Text fragments scattered in the level. */
  textFragments: TextFragment[];
  /** Ambient log fragments that occasionally appear in overlay. */
  ambientLogs: string[];
  /** Wall ids that can be pushed through to enter a generated room. */
  liminalWallIds?: number[];
}

export interface GameState {
  /** Runtime level list. Starts with authored levels and grows with generated rooms. */
  levels: LevelDef[];
  levelIndex: number;
  playerX: number;
  playerY: number;
  playerAngle: number;
  showLogOverlay: boolean;
  showHelp: boolean;
  /** Accumulated log messages (from text fragments walked near). */
  logLines: string[];
  exited: boolean;
  debug: boolean;
  /** Time accumulator for ambient log drips. */
  ambientTimer: number;
  /** Index into current level's ambientLogs. */
  ambientIndex: number;
  /** Frame counter. */
  frameCount: number;
  /** Number of generated rooms entered in this run. */
  generatedDepth: number;
}

/** Fixed game constants. */
export const GRID_CELL_SIZE = 1.0;
export const MOVE_SPEED = 2.5; // grid cells per second
export const ROTATE_SPEED = 2.5; // radians per second
export const PLAYER_RADIUS = 0.2;
export const MAX_LOG_LINES = 30;
export const AMBIENT_LOG_INTERVAL_SEC = 8;
export const MIN_TERMINAL_COLS = 40;
export const MIN_TERMINAL_ROWS = 12;
