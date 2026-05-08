/**
 * Synax Backrooms — hidden terminal exploration mode.
 *
 * Main game loop entry point. Manages state, input, rendering, and cleanup.
 * Exported as `runSynaxBackrooms()`.
 */
import { createBackroomsTerminal } from './terminal';
import { createBackroomsInput, type BackroomsAction } from './input';
import { renderFrame } from './renderer';
import { LEVELS } from './levels';
import { generateLiminalLevel, nextLiminalSeed } from './procedural';
import {
  type BackroomsOptions,
  type GameState,
  type LevelDef,
  type InputStreamLike,
  type Point,
  MOVE_SPEED,
  ROTATE_SPEED,
  PLAYER_RADIUS,
  MAX_LOG_LINES,
  AMBIENT_LOG_INTERVAL_SEC,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from './types';

const HELD_ACTION_TTL_MS = 140;

/**
 * Run the Synax Backrooms. Returns a Promise that resolves when the user exits.
 * Handles all terminal setup/teardown safely.
 */
export async function runSynaxBackrooms(options?: BackroomsOptions): Promise<void> {
  const term = createBackroomsTerminal({ stdin: options?.stdin, stdout: options?.stdout });
  const input = createBackroomsInput();

  // Validate terminal size
  if (term.columns < MIN_TERMINAL_COLS || term.rows < MIN_TERMINAL_ROWS) {
    // Don't even enter alt screen — just print and exit
    process.stderr.write('terminal too small for liminal layer\n');
    return;
  }

  // Guard: don't start if not a TTY (non-interactive mode)
  const stdin = options?.stdin as InputStreamLike | undefined;
  if (!stdin?.isTTY && !process.stdin.isTTY) {
    return; // silently skip in non-TTY environments
  }

  const debug = options?.debug ?? false;
  const fps = options?.fps ?? (options?.lowPower ? 12 : 60);
  const frameIntervalMs = 1000 / fps;

  // ─── Initialize state ──────────────────────────────────────

  const startLevel = LEVELS[0];
  const state: GameState = {
    levels: [...LEVELS],
    levelIndex: 0,
    playerX: startLevel.playerStart.x,
    playerY: startLevel.playerStart.y,
    playerAngle: startLevel.playerAngle,
    showLogOverlay: false,
    showHelp: false,
    logLines: [],
    exited: false,
    debug,
    ambientTimer: 0,
    ambientIndex: 0,
    frameCount: 0,
    generatedDepth: 0,
  };

  // ─── Input handling ────────────────────────────────────────

  // Raw terminals do not send key-up events reliably, so held movement is
  // approximated with short-lived key-repeat state. This allows WASD movement
  // and arrow rotation to overlap without leaving keys stuck after release.
  const heldMovement = new Map<BackroomsAction, number>();

  const processAction = (action: BackroomsAction): void => {
    switch (action) {
      case 'move_forward':
      case 'move_back':
      case 'strafe_left':
      case 'strafe_right':
      case 'turn_left':
      case 'turn_right':
        heldMovement.set(action, Date.now() + HELD_ACTION_TTL_MS);
        break;
      case 'toggle_overlay':
        state.showLogOverlay = !state.showLogOverlay;
        break;
      case 'toggle_help':
        state.showHelp = !state.showHelp;
        break;
      case 'interact':
        checkNearbyFragments(state);
        break;
      case 'level_1':
        if (debug) switchLevel(state, 0);
        break;
      case 'level_2':
        if (debug) switchLevel(state, 1);
        break;
      case 'level_3':
        if (debug) switchLevel(state, 2);
        break;
      case 'exit':
        state.exited = true;
        break;
    }
  };

  // ─── Signal handlers ───────────────────────────────────────

  const onSigint = (): void => {
    state.exited = true;
  };

  process.on('SIGINT', onSigint);

  // ─── Start ─────────────────────────────────────────────────

  term.start();

  try {
    const effectiveStdin = stdin ?? (process.stdin as unknown as InputStreamLike);
    input.attach(effectiveStdin, processAction);

    // First frame immediately
    const currentLevel = currentLevelFor(state);
    term.write(renderFrame(state, currentLevel, frameColumns(term.columns), term.rows));

    let lastFrameTime = Date.now();

    // Main loop
    while (!state.exited) {
      const now = Date.now();
      const deltaSec = Math.min((now - lastFrameTime) / 1000, 0.1); // cap delta to avoid spiral
      lastFrameTime = now;

      processMovement(state, activeMovementActions(heldMovement, now), deltaSec);

      // Ambient log drip
      state.ambientTimer += deltaSec;
      if (state.ambientTimer >= AMBIENT_LOG_INTERVAL_SEC) {
        state.ambientTimer -= AMBIENT_LOG_INTERVAL_SEC;
        dripAmbientLog(state);
      }

      // Check proximity to text fragments
      checkNearbyFragments(state);

      state.frameCount += 1;

      // Render
      const level = currentLevelFor(state);
      term.write(renderFrame(state, level, frameColumns(term.columns), term.rows));

      // Frame pacing
      const elapsed = Date.now() - now;
      const waitMs = Math.max(0, frameIntervalMs - elapsed);
      await sleep(waitMs);
    }
  } finally {
    // Clean up — always restore terminal even if renderer throws
    process.off('SIGINT', onSigint);
    const effectiveStdin = stdin ?? (process.stdin as unknown as InputStreamLike);
    input.detach(effectiveStdin);
    term.stop();
  }
}

function frameColumns(columns: number): number {
  return Math.max(1, columns - 1);
}

// ─── Movement ─────────────────────────────────────────────────

function activeMovementActions(heldMovement: Map<BackroomsAction, number>, nowMs: number): Set<BackroomsAction> {
  const active = new Set<BackroomsAction>();
  for (const [action, expiresAtMs] of heldMovement) {
    if (expiresAtMs <= nowMs) {
      heldMovement.delete(action);
      continue;
    }
    active.add(action);
  }
  return active;
}

export function processMovement(state: GameState, keysDown: Set<BackroomsAction>, deltaSec: number): void {
  const moveStep = MOVE_SPEED * deltaSec;
  const rotateStep = ROTATE_SPEED * deltaSec;
  const level = currentLevelFor(state);

  const cos = Math.cos(state.playerAngle);
  const sin = Math.sin(state.playerAngle);

  let moveX = 0;
  let moveY = 0;

  if (keysDown.has('move_forward')) {
    moveX += cos;
    moveY += sin;
  }
  if (keysDown.has('move_back')) {
    moveX -= cos;
    moveY -= sin;
  }
  if (keysDown.has('strafe_left')) {
    moveX += sin;
    moveY -= cos;
  }
  if (keysDown.has('strafe_right')) {
    moveX -= sin;
    moveY += cos;
  }

  const magnitude = Math.hypot(moveX, moveY);
  if (magnitude > 0) {
    const scale = moveStep / magnitude;
    tryMove(state, state.playerX + moveX * scale, state.playerY + moveY * scale, level);
  }

  // Rotation
  if (keysDown.has('turn_left')) {
    state.playerAngle -= rotateStep;
  }
  if (keysDown.has('turn_right')) {
    state.playerAngle += rotateStep;
  }
}

export function tryMove(state: GameState, newX: number, newY: number, level: LevelDef): void {
  // Check collision at new position with player radius
  const r = PLAYER_RADIUS;

  // Check corners and center
  const checks: Point[] = [
    { x: newX - r, y: newY - r },
    { x: newX + r, y: newY - r },
    { x: newX - r, y: newY + r },
    { x: newX + r, y: newY + r },
    { x: newX, y: newY },
  ];

  for (const check of checks) {
    const mx = Math.floor(check.x);
    const my = Math.floor(check.y);
    if (my < 0 || my >= level.map.length || mx < 0 || mx >= (level.map[0]?.length ?? 0)) {
      return; // out of bounds
    }
    if (level.map[my][mx] > 0) {
      if (isLiminalWall(level, mx, my)) {
        enterGeneratedLevel(state, mx, my);
      }
      return; // hit a wall
    }
  }

  // Allow sliding along walls: try X only, then Y only
  const canMoveX = ((): boolean => {
    const xChecks: Point[] = [
      { x: newX - r, y: state.playerY - r },
      { x: newX + r, y: state.playerY - r },
      { x: newX - r, y: state.playerY + r },
      { x: newX + r, y: state.playerY + r },
      { x: newX, y: state.playerY },
    ];
    for (const check of xChecks) {
      const mx = Math.floor(check.x);
      const my = Math.floor(check.y);
      if (my < 0 || my >= level.map.length || mx < 0 || mx >= (level.map[0]?.length ?? 0)) return false;
      if (level.map[my][mx] > 0) return false;
    }
    return true;
  })();

  const canMoveY = ((): boolean => {
    const yChecks: Point[] = [
      { x: state.playerX - r, y: newY - r },
      { x: state.playerX + r, y: newY - r },
      { x: state.playerX - r, y: newY + r },
      { x: state.playerX + r, y: newY + r },
      { x: state.playerX, y: newY },
    ];
    for (const check of yChecks) {
      const mx = Math.floor(check.x);
      const my = Math.floor(check.y);
      if (my < 0 || my >= level.map.length || mx < 0 || mx >= (level.map[0]?.length ?? 0)) return false;
      if (level.map[my][mx] > 0) return false;
    }
    return true;
  })();

  if (canMoveX) state.playerX = newX;
  if (canMoveY) state.playerY = newY;
}

// ─── Interactions ─────────────────────────────────────────────

function checkNearbyFragments(state: GameState): void {
  const level = currentLevelFor(state);
  const alreadyLogged = new Set(state.logLines);

  for (const frag of level.textFragments) {
    if (alreadyLogged.has(frag.text)) continue;

    const dx = state.playerX - frag.x;
    const dy = state.playerY - frag.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= frag.triggerRadius) {
      state.logLines.push(frag.text);
      if (state.logLines.length > MAX_LOG_LINES) {
        state.logLines = state.logLines.slice(-MAX_LOG_LINES);
      }
    }
  }
}

function dripAmbientLog(state: GameState): void {
  const level = currentLevelFor(state);
  if (level.ambientLogs.length === 0) return;

  const log = level.ambientLogs[state.ambientIndex % level.ambientLogs.length];
  state.ambientIndex += 1;

  state.logLines.push(log);
  if (state.logLines.length > MAX_LOG_LINES) {
    state.logLines = state.logLines.slice(-MAX_LOG_LINES);
  }
}

function switchLevel(state: GameState, index: number): void {
  if (index < 0 || index >= state.levels.length) return;
  state.levelIndex = index;
  const level = currentLevelFor(state);
  state.playerX = level.playerStart.x;
  state.playerY = level.playerStart.y;
  state.playerAngle = level.playerAngle;
  state.logLines = [];
  state.ambientIndex = 0;
  state.ambientTimer = 0;
  state.showLogOverlay = false;
}

function currentLevelFor(state: GameState): LevelDef {
  return state.levels[state.levelIndex] ?? state.levels[0] ?? LEVELS[0];
}

function isLiminalWall(level: LevelDef, x: number, y: number): boolean {
  const wallId = level.map[y]?.[x] ?? 0;
  return Boolean(wallId > 0 && level.liminalWallIds?.includes(wallId));
}

function enterGeneratedLevel(state: GameState, wallX: number, wallY: number): void {
  const nextDepth = state.generatedDepth + 1;
  const nextLevel = generateLiminalLevel(nextDepth, nextLiminalSeed(nextDepth, wallX, wallY));
  state.levels.push(nextLevel);
  state.levelIndex = state.levels.length - 1;
  state.generatedDepth = nextDepth;
  state.playerX = nextLevel.playerStart.x;
  state.playerY = nextLevel.playerStart.y;
  state.playerAngle = oppositeAngleFromWall(nextLevel, wallX, wallY);
  state.ambientIndex = 0;
  state.ambientTimer = 0;
  state.showLogOverlay = true;
  state.logLines = [`[liminal] crossed into generated room ${nextDepth}`];
}

function oppositeAngleFromWall(level: LevelDef, wallX: number, wallY: number): number {
  const width = level.map[0]?.length ?? 1;
  const height = level.map.length;
  if (wallX <= 0) return 0;
  if (wallX >= width - 1) return Math.PI;
  if (wallY <= 0) return Math.PI * 0.5;
  if (wallY >= height - 1) return Math.PI * 1.5;
  return Math.PI * 0.5;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
