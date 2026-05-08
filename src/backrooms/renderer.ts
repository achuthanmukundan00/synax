/**
 * Terminal depth renderer for Synax Backrooms.
 *
 * Uses DDA raycasting through a 2D grid, then shades a terminal framebuffer
 * with Unicode intensity ramps, procedural tile noise, distance fog, and
 * truecolor ANSI. Conceptually inspired by Lallapallooza/c_ascii_render.
 */
import type { GameState, LevelDef, WallDef } from './types';

const FOV = Math.PI / 3;
const CAMERA_HEIGHT = 0.48;
const WALL_VERTICAL_SCALE = 1.65;
const FAR_CLIP = 18;
const SHADE_CHARS = ' .`,:;irsXA253hMHGS#9B&@';

interface RayHit {
  distance: number;
  wallId: number;
  side: 0 | 1;
  wallX: number;
}

interface RayColumn {
  correctedDistance: number;
  wallHeight: number;
  wallId: number;
  side: 0 | 1;
  wallX: number;
  rayAngle: number;
}

interface CellSample {
  char: string;
  color: [number, number, number];
}

export function renderFrame(state: GameState, level: LevelDef, cols: number, rows: number): string {
  const screenWidth = cols;
  const screenHeight = rows;
  const rays: RayColumn[] = [];

  for (let x = 0; x < screenWidth; x += 1) {
    const cameraX = (2 * x) / screenWidth - 1;
    const rayAngle = state.playerAngle + Math.atan(cameraX * Math.tan(FOV / 2));
    const hit = castRay(state.playerX, state.playerY, rayAngle, level);
    const correctedDistance = Math.max(0.05, hit.distance * Math.cos(rayAngle - state.playerAngle));
    rays.push({
      correctedDistance,
      wallHeight: (screenHeight / correctedDistance) * WALL_VERTICAL_SCALE,
      wallId: hit.wallId,
      side: hit.side,
      wallX: hit.wallX,
      rayAngle,
    });
  }

  const lines: string[] = [];
  for (let y = 0; y < screenHeight; y += 1) {
    const screenY = y + 0.5;
    const chars: string[] = [];

    for (let x = 0; x < screenWidth; x += 1) {
      const ray = rays[x];
      const wallCenter = screenHeight * CAMERA_HEIGHT;
      const wallTop = wallCenter - ray.wallHeight / 2;
      const wallBottom = wallCenter + ray.wallHeight / 2;
      const sample =
        screenY >= wallTop && screenY <= wallBottom
          ? sampleWall(screenY, x, ray, level, wallTop, wallBottom)
          : samplePlane(screenY, x, ray.rayAngle, level, screenHeight, screenWidth, state.frameCount);

      chars.push(renderCell(sample));
    }

    lines.push(chars.join(''));
  }

  const combined = combineLines(lines, buildHud(state, level, cols, rows));
  return `\u001b[H${combined.join('\r\n')}\u001b[0m`;
}

function sampleWall(
  screenY: number,
  screenX: number,
  ray: RayColumn,
  level: LevelDef,
  wallTop: number,
  wallBottom: number,
): CellSample {
  const wallDef = findWallDef(level.walls, ray.wallId);
  const baseColor = wallDef?.color ?? [95, 95, 95];
  const vertical = clamp01((screenY - wallTop) / Math.max(1, wallBottom - wallTop));
  const brick = ray.wallX % 0.25;
  const mortar = Math.min(brick, 0.25 - brick) < 0.014 || Math.abs(vertical - 0.5) < 0.012;
  const panelNoise = hash2(Math.floor(ray.wallX * 32), Math.floor(vertical * 24) + screenX);
  const sideLight = ray.side === 0 ? 1 : 0.66;
  const lightBand = 0.78 + 0.22 * Math.cos((ray.wallX * 5 + vertical * 2) * Math.PI);
  const depth = depthFog(ray.correctedDistance);
  const intensity = clamp01(
    (1.12 - ray.correctedDistance / FAR_CLIP) * sideLight * lightBand - (mortar ? 0.2 : 0) + panelNoise * 0.09,
  );

  return {
    char: intensityToChar(intensity * depth + (mortar ? 0.05 : 0)),
    color: shadeColor(baseColor, 0.1 + intensity * depth * 0.95),
  };
}

function samplePlane(
  screenY: number,
  screenX: number,
  rayAngle: number,
  level: LevelDef,
  height: number,
  width: number,
  frameCount: number,
): CellSample {
  const horizon = height * CAMERA_HEIGHT;
  const isFloor = screenY > horizon;
  const rowDistance = Math.min(FAR_CLIP, height / Math.max(0.3, Math.abs(screenY - horizon) * 2.7));
  const worldX = Math.cos(rayAngle) * rowDistance;
  const worldY = Math.sin(rayAngle) * rowDistance;
  const baseColor = isFloor ? level.floorColor : level.ceilingColor;
  const scale = isFloor ? 1.35 : 0.82;
  const tileX = Math.floor(worldX * scale);
  const tileY = Math.floor(worldY * scale);
  const grid =
    Math.abs(worldX * scale - Math.round(worldX * scale)) < 0.035 ||
    Math.abs(worldY * scale - Math.round(worldY * scale)) < 0.035;
  const noise = hash2(tileX, tileY);
  const centerFalloff = 1 - Math.abs((screenX / Math.max(1, width - 1)) * 2 - 1) * 0.18;
  const flicker = isFloor ? 0 : 0.08 * Math.sin(frameCount * 0.07 + screenX * 0.17);
  const baseIntensity = isFloor ? 0.17 + noise * 0.18 : 0.15 + noise * 0.1 + flicker;
  const intensity = clamp01((baseIntensity - (grid ? 0.08 : 0)) * depthFog(rowDistance) * centerFalloff);

  return {
    char: intensityToChar(intensity * (isFloor ? 0.85 : 0.65)),
    color: shadeColor(baseColor, 0.1 + intensity),
  };
}

function renderCell(sample: CellSample): string {
  const [r, g, b] = sample.color;
  return `\u001b[38;2;${r};${g};${b}m${sample.char}`;
}

function findWallDef(walls: WallDef[], id: number): WallDef | undefined {
  return walls.find((w) => w.id === id);
}

function shadeColor(color: [number, number, number], factor: number): [number, number, number] {
  return [
    clampByte(Math.floor(color[0] * factor)),
    clampByte(Math.floor(color[1] * factor)),
    clampByte(Math.floor(color[2] * factor)),
  ];
}

function intensityToChar(intensity: number): string {
  const index = Math.max(
    0,
    Math.min(SHADE_CHARS.length - 1, Math.floor(clamp01(intensity) * (SHADE_CHARS.length - 1))),
  );
  return SHADE_CHARS[index] ?? ' ';
}

function depthFog(distance: number): number {
  return Math.pow(1 - clamp01(distance / FAR_CLIP), 1.7);
}

function hash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, v));
}

function castRay(x: number, y: number, angle: number, level: LevelDef): RayHit {
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  let mapX = Math.floor(x);
  let mapY = Math.floor(y);
  const deltaDistX = dirX === 0 ? 1e30 : Math.abs(1 / dirX);
  const deltaDistY = dirY === 0 ? 1e30 : Math.abs(1 / dirY);

  let stepX: number;
  let stepY: number;
  let sideDistX: number;
  let sideDistY: number;

  if (dirX < 0) {
    stepX = -1;
    sideDistX = (x - mapX) * deltaDistX;
  } else {
    stepX = 1;
    sideDistX = (mapX + 1 - x) * deltaDistX;
  }

  if (dirY < 0) {
    stepY = -1;
    sideDistY = (y - mapY) * deltaDistY;
  } else {
    stepY = 1;
    sideDistY = (mapY + 1 - y) * deltaDistY;
  }

  let side: 0 | 1 = 0;
  let hit = false;
  for (let i = 0; i < 96; i += 1) {
    if (sideDistX < sideDistY) {
      sideDistX += deltaDistX;
      mapX += stepX;
      side = 0;
    } else {
      sideDistY += deltaDistY;
      mapY += stepY;
      side = 1;
    }

    if (mapY < 0 || mapY >= level.map.length || mapX < 0 || mapX >= (level.map[0]?.length ?? 0)) {
      return { distance: FAR_CLIP, wallId: 0, side: 0, wallX: 0 };
    }

    if (level.map[mapY][mapX] > 0) {
      hit = true;
      break;
    }
  }

  if (!hit) return { distance: FAR_CLIP, wallId: 0, side: 0, wallX: 0 };

  const distance = Math.max(0.1, side === 0 ? sideDistX - deltaDistX : sideDistY - deltaDistY);
  const hitWorldX = x + dirX * distance;
  const hitWorldY = y + dirY * distance;
  const wallX = side === 0 ? hitWorldY - Math.floor(hitWorldY) : hitWorldX - Math.floor(hitWorldX);

  return {
    distance,
    wallId: level.map[mapY][mapX],
    side,
    wallX,
  };
}

function buildHud(
  state: GameState,
  level: LevelDef,
  cols: number,
  _rows: number,
): { lineIndex: number; text: string }[] {
  const overlays: { lineIndex: number; text: string }[] = [];
  overlays.push({ lineIndex: 0, text: `\u001b[90m${level.name.padEnd(cols)}\u001b[0m` });

  if (state.showHelp) {
    const helpLines = [
      '  WASD: move  |  Arrows: turn/view  |  Q/Esc: exit  |  L: overlay  |  H: help',
      '  violet walls: keep walking into them to enter another room',
      '  terminal render inspiration: Lallapallooza/c_ascii_render',
    ];
    const helpStart = _rows - helpLines.length - (state.showLogOverlay ? Math.min(state.logLines.length, 7) : 0);
    for (let i = 0; i < helpLines.length; i += 1) {
      overlays.push({
        lineIndex: helpStart + i,
        text: `\u001b[90m${helpLines[i].padEnd(cols)}\u001b[0m`,
      });
    }
  }

  if (state.debug) {
    const debugLine = `[DEBUG] FPS:${state.frameCount} pos:(${state.playerX.toFixed(1)},${state.playerY.toFixed(1)}) ang:${((state.playerAngle * 180) / Math.PI).toFixed(0)} lvl:${state.levelIndex + 1}`;
    overlays.push({ lineIndex: 0, text: `\u001b[90m${debugLine.padEnd(cols)}\u001b[0m` });
  }

  if (state.showLogOverlay && state.logLines.length > 0) {
    const visible = state.logLines.slice(-7);
    for (let i = 0; i < visible.length; i += 1) {
      overlays.push({
        lineIndex: _rows - 7 + i,
        text: `\u001b[48;2;20;20;30m\u001b[38;2;150;200;150m ${visible[i].padEnd(cols - 1)}\u001b[0m`,
      });
    }
  }

  return overlays;
}

function combineLines(baseLines: string[], overlays: { lineIndex: number; text: string }[]): string[] {
  const result = [...baseLines];
  for (const { lineIndex, text } of overlays) {
    if (lineIndex >= 0 && lineIndex < result.length) {
      result[lineIndex] = text;
    }
  }
  return result;
}
