import type { LevelDef } from './types';

const ROOM_SIZE = 24;
const WALL = 1;
const PILLAR = 2;
const SEAM = 9;

const WALL_COLOR: [number, number, number] = [42, 47, 52];
const PILLAR_COLOR: [number, number, number] = [52, 48, 58];
const SEAM_COLOR: [number, number, number] = [78, 64, 98];
const FLOOR_COLOR: [number, number, number] = [18, 21, 22];
const CEILING_COLOR: [number, number, number] = [12, 14, 17];

const NAME_PREFIXES = [
  'ClosedAI',
  'Misanthropic',
  'ZuckNet',
  'ShallowMind',
  'Qwhen',
  'Mistroll',
  'Gronk',
  'DeepSneak',
  'Coheresay',
  'Perplexed',
  'Shrugging Face',
  'NVIDious',
  'Delay',
  'Ollamnesia',
  'Drama',
  'Clod',
  'Geminy',
  'ChadGPT',
  'Snora',
  'Codecks',
];

const NAME_MIDDLES = [
  'Alignment',
  'Attention',
  'Benchmark',
  'Context',
  'Data',
  'Dataset',
  'Distillation',
  'Embedding',
  'Ethics',
  'Eval',
  'Fine-Tuning',
  'Gradient',
  'Inference',
  'Latent',
  'Memory',
  'Mixture',
  'Policy',
  'Prompt',
  'Quantization',
  'Reasoning',
  'Red Team',
  'RLHF',
  'Safety',
  'Shoggoth',
  'Surveillance',
  'Synthetic',
  'Token',
  'Tool Call',
  'Transformer',
  'Weights',
];

const NAME_SUFFIXES = [
  'Archive',
  'Atrium',
  'Basement',
  'Bunker',
  'Chamber',
  'Cluster',
  'Containment Wing',
  'Data Lake',
  'Depot',
  'Evaluation Hall',
  'Factory',
  'Forge',
  'Hallucination Ward',
  'Lab',
  'Lobby',
  'Maze',
  'Observatory',
  'Operations Suite',
  'Portal',
  'Reactor',
  'Sandbox',
  'Shard',
  'Suite',
  'Tunnel',
  'Vault',
  'Warehouse',
];

export function generateLiminalLevel(depth: number, seed: number): LevelDef {
  const random = mulberry32(seed);
  const map = emptyRoom();
  const name = generateRoomName(depth, random);

  carveRoomShell(map);
  carveHallSpokes(map);
  scatterPillars(map, random);
  placeLiminalSeams(map, random);

  return {
    name,
    map,
    playerStart: { x: ROOM_SIZE / 2, y: ROOM_SIZE / 2 },
    playerAngle: random() * Math.PI * 2,
    walls: [
      { id: WALL, color: WALL_COLOR },
      { id: PILLAR, color: PILLAR_COLOR },
      { id: SEAM, color: SEAM_COLOR },
    ],
    floorColor: FLOOR_COLOR,
    ceilingColor: CEILING_COLOR,
    textFragments: [
      { text: `room index: ${depth}`, x: 11.5, y: 11.5, triggerRadius: 2.5 },
      { text: 'the wall accepts pressure', x: 1.5, y: 12.5, triggerRadius: 2 },
      { text: 'there is always another room', x: 22.5, y: 12.5, triggerRadius: 2 },
    ],
    ambientLogs: [
      `[liminal] generated room ${depth}`,
      '[liminal] boundary classification: unstable',
      '[liminal] hallway length exceeds map index',
      '[liminal] press into a violet wall to continue',
    ],
    liminalWallIds: [SEAM],
  };
}

export function generateRoomName(depth: number, random: () => number): string {
  const prefix = pick(NAME_PREFIXES, random);
  const middle = pick(NAME_MIDDLES, random);
  const suffix = pick(NAME_SUFFIXES, random);
  return `${prefix} ${middle} ${suffix} ${depth.toString().padStart(3, '0')}`;
}

export function nextLiminalSeed(depth: number, x: number, y: number): number {
  const xi = Math.floor(x * 1000);
  const yi = Math.floor(y * 1000);
  return (0x9e3779b9 ^ Math.imul(depth + 1, 0x85ebca6b) ^ Math.imul(xi, 0xc2b2ae35) ^ yi) >>> 0;
}

function emptyRoom(): number[][] {
  return Array.from({ length: ROOM_SIZE }, () => Array.from({ length: ROOM_SIZE }, () => 0));
}

function carveRoomShell(map: number[][]): void {
  for (let y = 0; y < ROOM_SIZE; y += 1) {
    for (let x = 0; x < ROOM_SIZE; x += 1) {
      if (x === 0 || y === 0 || x === ROOM_SIZE - 1 || y === ROOM_SIZE - 1) {
        map[y][x] = WALL;
      }
    }
  }
}

function carveHallSpokes(map: number[][]): void {
  const mid = Math.floor(ROOM_SIZE / 2);
  for (let i = 1; i < ROOM_SIZE - 1; i += 1) {
    map[mid][i] = 0;
    map[mid - 1][i] = 0;
    map[i][mid] = 0;
    map[i][mid - 1] = 0;
  }
}

function scatterPillars(map: number[][], random: () => number): void {
  for (let y = 3; y < ROOM_SIZE - 3; y += 1) {
    for (let x = 3; x < ROOM_SIZE - 3; x += 1) {
      const nearCenter = Math.abs(x - ROOM_SIZE / 2) < 3 && Math.abs(y - ROOM_SIZE / 2) < 3;
      const inSpoke = x === 11 || x === 12 || y === 11 || y === 12;
      if (!nearCenter && !inSpoke && random() < 0.12) {
        map[y][x] = PILLAR;
      }
    }
  }
}

function placeLiminalSeams(map: number[][], random: () => number): void {
  const mid = Math.floor(ROOM_SIZE / 2);
  const offsets = [-4, 0, 4];
  for (const offset of offsets) {
    map[0][mid + offset] = SEAM;
    map[ROOM_SIZE - 1][mid + offset] = SEAM;
    map[mid + offset][0] = SEAM;
    map[mid + offset][ROOM_SIZE - 1] = SEAM;
  }

  for (let i = 0; i < 5; i += 1) {
    const x = 2 + Math.floor(random() * (ROOM_SIZE - 4));
    const y = 2 + Math.floor(random() * (ROOM_SIZE - 4));
    if (map[y][x] === PILLAR) {
      map[y][x] = SEAM;
    }
  }
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(values: string[], random: () => number): string {
  return values[Math.floor(random() * values.length)] ?? values[0] ?? 'Unindexed';
}
