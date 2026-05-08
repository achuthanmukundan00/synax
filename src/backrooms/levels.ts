/**
 * Level definitions for Synax Backrooms.
 *
 * Each level is a hand-authored 2D grid map. Walls are non-zero numbers
 * referencing a wall definition with color.
 *
 * Map orientation: rows = y (increasing south), cols = x (increasing east).
 * Origin (0,0) is top-left of the grid.
 */
import type { LevelDef } from './types';

// ─── Wall palettes ──────────────────────────────────────────────

const FLUORESCENT_WALL: [number, number, number] = [180, 200, 180];
const FLUORESCENT_CEILING: [number, number, number] = [220, 230, 200];
const FLUORESCENT_FLOOR: [number, number, number] = [40, 45, 40];
const DOOR_COLOR: [number, number, number] = [100, 100, 120];
const PROVIDER_DOOR: [number, number, number] = [60, 70, 90];
const NULL_WALL: [number, number, number] = [30, 30, 35];

const CORRUPT_WALL_A: [number, number, number] = [50, 20, 50];
const CORRUPT_WALL_B: [number, number, number] = [70, 15, 40];
const CORRUPT_FLOOR: [number, number, number] = [15, 10, 20];
const CORRUPT_CEILING: [number, number, number] = [10, 5, 15];
const GLYPH_WALL: [number, number, number] = [30, 40, 30];

const TUNNEL_WALL: [number, number, number] = [25, 30, 40];
const TUNNEL_CEILING: [number, number, number] = [10, 15, 25];
const TUNNEL_FLOOR: [number, number, number] = [20, 25, 30];
const GATE_WALL: [number, number, number] = [50, 60, 80];
const PULSE_WALL: [number, number, number] = [40, 50, 70];
const UNSTABLE_WALL: [number, number, number] = [30, 25, 45];

// ─── Level 1: Provider Hall ────────────────────────────────────

const PROVIDER_HALL_MAP: number[][] = [
  // 24x24 grid — long fluorescent hallway with provider doors
  // row 0 (top)
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 1],
  [1, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 1],
  [1, 2, 0, 2, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 3, 0, 2, 0, 2, 0, 1],
  [1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 1],
  [1, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 4, 4, 4, 4, 0, 0, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const PROVIDER_HALL: LevelDef = {
  name: 'Provider Hall',
  map: PROVIDER_HALL_MAP,
  playerStart: { x: 2.5, y: 2.5 },
  playerAngle: Math.PI * 0.5,
  walls: [
    { id: 1, color: FLUORESCENT_WALL },
    { id: 2, color: PROVIDER_DOOR },
    { id: 3, color: DOOR_COLOR },
    { id: 4, color: NULL_WALL },
  ],
  floorColor: FLUORESCENT_FLOOR,
  ceilingColor: FLUORESCENT_CEILING,
  textFragments: [
    { text: 'provider handshake timed out', x: 1.5, y: 3.5, triggerRadius: 2 },
    { text: 'default model not found', x: 1.5, y: 6.5, triggerRadius: 2 },
    { text: 'free tier route abandoned', x: 21.5, y: 3.5, triggerRadius: 2 },
    { text: 'do not expose user key', x: 21.5, y: 9.5, triggerRadius: 2 },
    { text: 'openrouter', x: 1.5, y: 9.5, triggerRadius: 1.5 },
    { text: 'relay', x: 5.5, y: 3.5, triggerRadius: 1.5 },
    { text: 'lmstudio', x: 9.5, y: 9.5, triggerRadius: 1.5 },
    { text: 'qwen', x: 13.5, y: 3.5, triggerRadius: 1.5 },
    { text: 'anthropic', x: 17.5, y: 9.5, triggerRadius: 1.5 },
    { text: 'null', x: 11.5, y: 17.5, triggerRadius: 2.5 },
  ],
  ambientLogs: [
    '[provider] handshake timeout 30s',
    '[provider] route /openrouter: 503 upstream unavailable',
    '[provider] fallback to relay… relay not configured',
    '[provider] model qwen-2.5-coder not found in local cache',
    '[provider] key ANTHROPIC_API_KEY: empty string',
    '[provider] free tier exhausted for lmstudio endpoint',
    '[provider] null provider selected — no completions available',
    '[provider] config reload: 0 active providers',
  ],
  liminalWallIds: [4],
};

// ─── Level 2: Context Overflow ─────────────────────────────────

const CONTEXT_OVERFLOW_MAP: number[][] = [
  // Warped memory chamber — narrowing corridors, glyph noise
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 1],
  [1, 0, 0, 0, 2, 0, 0, 0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 0, 0, 2, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 2, 2, 0, 0, 0, 0, 2, 0, 0, 0, 2, 2, 0, 0, 0, 2, 0, 0, 0, 0, 2, 2, 1],
  [1, 2, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 2, 1],
  [1, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 3, 3, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
  [1, 0, 0, 2, 0, 0, 0, 2, 0, 0, 3, 3, 3, 3, 3, 3, 0, 0, 2, 0, 0, 0, 0, 1],
  [1, 0, 2, 0, 0, 0, 2, 0, 0, 3, 3, 3, 3, 3, 3, 3, 3, 0, 0, 2, 0, 0, 0, 1],
  [1, 2, 0, 0, 0, 2, 0, 0, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 0, 0, 2, 0, 0, 1],
  [1, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 3, 3, 3, 3, 0, 0, 2, 0, 0, 0, 2, 0, 1],
  [1, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
  [1, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 1],
  [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 0, 2, 0, 0, 0, 1],
  [1, 2, 2, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 2, 1],
  [1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1],
  [1, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 2, 0, 0, 2, 0, 0, 0, 0, 0, 2, 2, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 4, 4, 0, 0, 0, 2, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 4, 4, 4, 4, 0, 0, 0, 2, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 4, 4, 4, 4, 4, 4, 0, 0, 0, 2, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const CONTEXT_OVERFLOW: LevelDef = {
  name: 'Context Overflow',
  map: CONTEXT_OVERFLOW_MAP,
  playerStart: { x: 3.5, y: 2.5 },
  playerAngle: Math.PI * 0.25,
  walls: [
    { id: 1, color: CORRUPT_WALL_A },
    { id: 2, color: CORRUPT_WALL_B },
    { id: 3, color: GLYPH_WALL },
    { id: 4, color: [25, 10, 35] as [number, number, number] },
  ],
  floorColor: CORRUPT_FLOOR,
  ceilingColor: CORRUPT_CEILING,
  textFragments: [
    { text: 'context budget exceeded', x: 3.5, y: 5.5, triggerRadius: 2.5 },
    { text: 'compaction artifact detected', x: 12.5, y: 3.5, triggerRadius: 2 },
    { text: 'summary recursion depth: unknown', x: 10.5, y: 10.5, triggerRadius: 2.5 },
    { text: 'loaded context is not memory', x: 18.5, y: 7.5, triggerRadius: 2 },
    { text: 'token fragment: eos_token_id', x: 6.5, y: 14.5, triggerRadius: 2 },
    { text: 'attention head: null', x: 14.5, y: 16.5, triggerRadius: 2 },
    { text: 'reserved output: overflow', x: 18.5, y: 20.5, triggerRadius: 2.5 },
  ],
  ambientLogs: [
    '[context] estimated input tokens: 131072 / 32768',
    '[context] budget exhausted — compaction triggered',
    '[context] compaction ratio: 0.43 — below threshold',
    '[context] warning: summary recursion depth 7',
    '[context] artifact: duplicate system prompt block detected',
    '[context] memory is not retained across compaction rounds',
    '[context] keepRecentTokens: 0 — all prior context lost',
    '[context] maxSingleReadResult exceeded — truncating',
  ],
  liminalWallIds: [4],
};

// ─── Level 3: Relay Tunnel ─────────────────────────────────────

const RELAY_TUNNEL_MAP: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 3, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 2, 2, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 2, 2, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 4, 4, 0, 0, 3, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 4, 0, 0, 4, 0, 3, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 3, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 3, 0, 1],
  [1, 0, 0, 3, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 3, 1],
  [1, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 3, 0, 0, 0, 3, 1],
  [1, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 5, 5, 0, 0, 0, 3, 0, 0, 0, 3, 0, 1],
  [1, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 2, 2, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 4, 4, 0, 0, 0, 3, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 4, 0, 0, 0, 3, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 4, 0, 0, 0, 0, 4, 0, 0, 3, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 3, 0, 4, 0, 0, 0, 0, 0, 0, 4, 0, 3, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const RELAY_TUNNEL: LevelDef = {
  name: 'Relay Tunnel',
  map: RELAY_TUNNEL_MAP,
  playerStart: { x: 2.5, y: 16.5 },
  playerAngle: Math.PI * 0.0,
  walls: [
    { id: 1, color: TUNNEL_WALL },
    { id: 2, color: [35, 40, 50] as [number, number, number] },
    { id: 3, color: PULSE_WALL },
    { id: 4, color: GATE_WALL },
    { id: 5, color: UNSTABLE_WALL },
  ],
  floorColor: TUNNEL_FLOOR,
  ceilingColor: TUNNEL_CEILING,
  textFragments: [
    { text: '/v1/chat/completions', x: 4.5, y: 11.5, triggerRadius: 2.5 },
    { text: '/v1/messages', x: 12.5, y: 11.5, triggerRadius: 2 },
    { text: 'stream boundary recovered', x: 11.5, y: 19.5, triggerRadius: 2 },
    { text: 'upstream status: unknown', x: 4.5, y: 21.5, triggerRadius: 2.5 },
    { text: 'POST → relay:11434', x: 11.5, y: 5.5, triggerRadius: 2 },
    { text: 'SSE stream interrupted', x: 19.5, y: 7.5, triggerRadius: 2 },
    { text: 'upstream gate', x: 11.5, y: 3.5, triggerRadius: 1.5 },
    { text: 'downstream gate', x: 11.5, y: 20.5, triggerRadius: 1.5 },
  ],
  ambientLogs: [
    '[relay] POST /v1/chat/completions → upstream:11434',
    '[relay] stream event: delta.content "I can help with that."',
    '[relay] SSE connection interrupted after 412 chunks',
    '[relay] upstream response: 502 Bad Gateway',
    '[relay] retrying… attempt 3/3',
    '[relay] warning: upstream latency 8432ms',
    '[relay] chunk buffer overflow — dropping oldest 64 chunks',
    '[relay] stream boundary recovered after truncation',
  ],
  liminalWallIds: [5],
};

// ─── Level registry ────────────────────────────────────────────

export const LEVELS: LevelDef[] = [PROVIDER_HALL, CONTEXT_OVERFLOW, RELAY_TUNNEL];
