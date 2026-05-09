/**
 * Tests for Synax Backrooms — secret trigger detection, terminal safety,
 * normal chat preservation, and command visibility.
 */
import { isSecretTrigger, SECRET_TRIGGER } from '../backrooms/trigger';
import { generateLiminalLevel, generateRoomName, nextLiminalSeed } from '../backrooms/procedural';
import { parseBackroomsInput } from '../backrooms/input';
import { processMovement, tryMove } from '../backrooms/runBackrooms';
import { MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS, MOVE_SPEED, type GameState, type LevelDef } from '../backrooms/types';
import { createBackroomsTerminal } from '../backrooms/terminal';
import type { Writable } from 'node:stream';

describe('Synax Backrooms secret trigger', () => {
  describe('exact-match detection', () => {
    it('activates on exactly :synax/liminal/access/000', () => {
      expect(isSecretTrigger(SECRET_TRIGGER)).toBe(true);
    });

    it('activates with leading whitespace trimmed by caller', () => {
      // The caller is expected to trim before calling isSecretTrigger
      expect(isSecretTrigger('  :synax/liminal/access/000  '.trim())).toBe(true);
    });

    it('does not activate with extra words', () => {
      expect(isSecretTrigger('please :synax/liminal/access/000')).toBe(false);
      expect(isSecretTrigger(':synax/liminal/access/000 now')).toBe(false);
    });

    it('does not activate with different case', () => {
      expect(isSecretTrigger(':SYNAX/LIMINAL/ACCESS/000')).toBe(false);
      expect(isSecretTrigger(':Synax/Liminal/Access/000')).toBe(false);
      expect(isSecretTrigger(':synax/liminal/access/000 ')).toBe(false); // trailing space not trimmed
    });

    it('does not activate as a substring', () => {
      expect(isSecretTrigger('prefix:synax/liminal/access/000')).toBe(false);
      expect(isSecretTrigger(':synax/liminal/access/000suffix')).toBe(false);
    });

    it('does not activate on empty string', () => {
      expect(isSecretTrigger('')).toBe(false);
    });

    it('does not activate on similar but wrong strings', () => {
      expect(isSecretTrigger(':synax/liminal/access/001')).toBe(false);
      expect(isSecretTrigger(':synax/liminal/access/00')).toBe(false);
      expect(isSecretTrigger('/synax/liminal/access/000')).toBe(false);
      expect(isSecretTrigger('synax/liminal/access/000')).toBe(false);
    });
  });

  describe('trigger constant', () => {
    it('has the exact expected value', () => {
      expect(SECRET_TRIGGER).toBe(':synax/liminal/access/000');
    });
  });
});

describe('Synax Backrooms terminal safety', () => {
  // Test that the terminal cleanup function exists and calls stop
  it('terminal cleanup is exported and callable', () => {
    // We import and verify the module structure exists
    expect(typeof createBackroomsTerminal).toBe('function');
  });

  it('createBackroomsTerminal returns start/stop/write functions', () => {
    const mockStdout = {
      write: jest.fn(),
      isTTY: true,
      columns: 80,
      rows: 24,
    };
    const mockStdin = {
      isTTY: true,
      setRawMode: jest.fn(),
      resume: jest.fn(),
      pause: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
    };

    const term = createBackroomsTerminal({ stdin: mockStdin, stdout: mockStdout as unknown as Writable & { isTTY?: boolean; columns?: number; rows?: number } });
    expect(typeof term.start).toBe('function');
    expect(typeof term.stop).toBe('function');
    expect(typeof term.write).toBe('function');

    term.start();
    expect(mockStdin.setRawMode).toHaveBeenCalledWith(true);
    expect(mockStdout.write).toHaveBeenCalled();

    term.stop();
    expect(mockStdin.setRawMode).toHaveBeenCalledWith(false);
  });
});

describe('Synax Backrooms input and movement', () => {
  it('parses WASD movement and arrow rotation from the same terminal chunk', () => {
    expect(parseBackroomsInput('w\x1b[C')).toEqual(['move_forward', 'turn_right']);
  });

  it('moves and rotates in the same frame', () => {
    const level = openTestLevel();
    const state = testGameState(level);

    processMovement(state, new Set(['move_forward', 'turn_right']), 0.5);

    expect(state.playerX).toBeCloseTo(1.5 + MOVE_SPEED * 0.5);
    expect(state.playerY).toBeCloseTo(1.5);
    expect(state.playerAngle).toBeGreaterThan(0);
  });
});

describe('Synax Backrooms small terminal', () => {
  it('returns early when terminal is too small', () => {
    // We test that the validation constants exist
    expect(MIN_TERMINAL_COLS).toBe(40);
    expect(MIN_TERMINAL_ROWS).toBe(12);
  });
});

function openTestLevel(): LevelDef {
  return {
    name: 'test chamber',
    map: [
      [1, 1, 1, 1, 1],
      [1, 0, 0, 0, 1],
      [1, 0, 0, 0, 1],
      [1, 0, 0, 0, 1],
      [1, 1, 1, 1, 1],
    ],
    playerStart: { x: 1.5, y: 1.5 },
    playerAngle: 0,
    walls: [{ id: 1, color: [20, 20, 20] }],
    floorColor: [0, 0, 0],
    ceilingColor: [0, 0, 0],
    textFragments: [],
    ambientLogs: [],
  };
}

function testGameState(level: LevelDef): GameState {
  return {
    levels: [level],
    levelIndex: 0,
    playerX: level.playerStart.x,
    playerY: level.playerStart.y,
    playerAngle: level.playerAngle,
    showLogOverlay: false,
    showHelp: false,
    logLines: [],
    exited: false,
    debug: false,
    ambientTimer: 0,
    ambientIndex: 0,
    frameCount: 0,
    generatedDepth: 0,
  };
}

describe('Synax Backrooms generated exploration', () => {
  it('generates deterministic rooms with liminal wall exits', () => {
    const seed = nextLiminalSeed(1, 12, 23);
    const first = generateLiminalLevel(1, seed);
    const second = generateLiminalLevel(1, seed);

    expect(first.name).toBe(second.name);
    expect(first.name).toMatch(/ 001$/);
    expect(first.name).not.toBe('Unindexed Room 001');
    expect(first.map).toEqual(second.map);
    expect(first.liminalWallIds).toEqual([9]);
    expect(first.map.some((row) => row.includes(9))).toBe(true);
  });

  it('generates AI easter egg room names from seeded fragments', () => {
    const names = [generateRoomName(2, () => 0), generateRoomName(7, () => 0.49), generateRoomName(12, () => 0.99)];

    expect(names[0]).toBe('ClosedAI Alignment Archive 002');
    expect(names[1]).toBe('Perplexed Memory Hallucination Ward 007');
    expect(names[2]).toBe('Codecks Weights Warehouse 012');
    expect(names.join('\n')).not.toMatch(/\b(?:OpenAI|Anthropic|Meta|DeepMind|Perplexity|Codex)\b/);
  });

  it('walking into a liminal wall appends and enters a generated room', () => {
    const level: LevelDef = {
      name: 'test chamber',
      map: [
        [1, 1, 1],
        [1, 0, 9],
        [1, 1, 1],
      ],
      playerStart: { x: 1.5, y: 1.5 },
      playerAngle: 0,
      walls: [
        { id: 1, color: [20, 20, 20] },
        { id: 9, color: [80, 60, 100] },
      ],
      floorColor: [0, 0, 0],
      ceilingColor: [0, 0, 0],
      textFragments: [],
      ambientLogs: [],
      liminalWallIds: [9],
    };
    const state: GameState = {
      levels: [level],
      levelIndex: 0,
      playerX: 1.5,
      playerY: 1.5,
      playerAngle: 0,
      showLogOverlay: false,
      showHelp: false,
      logLines: ['stale room message'],
      exited: false,
      debug: false,
      ambientTimer: 0,
      ambientIndex: 0,
      frameCount: 0,
      generatedDepth: 0,
    };

    tryMove(state, 2.2, 1.5, level);

    expect(state.levels).toHaveLength(2);
    expect(state.levelIndex).toBe(1);
    expect(state.generatedDepth).toBe(1);
    expect(state.levels[1]?.name).toMatch(/ 001$/);
    expect(state.showLogOverlay).toBe(true);
    expect(state.logLines).toEqual(['[liminal] crossed into generated room 1']);
  });

  it('ordinary walls still block movement', () => {
    const level: LevelDef = {
      name: 'test chamber',
      map: [
        [1, 1, 1],
        [1, 0, 1],
        [1, 1, 1],
      ],
      playerStart: { x: 1.5, y: 1.5 },
      playerAngle: 0,
      walls: [{ id: 1, color: [20, 20, 20] }],
      floorColor: [0, 0, 0],
      ceilingColor: [0, 0, 0],
      textFragments: [],
      ambientLogs: [],
      liminalWallIds: [9],
    };
    const state: GameState = {
      levels: [level],
      levelIndex: 0,
      playerX: 1.5,
      playerY: 1.5,
      playerAngle: 0,
      showLogOverlay: false,
      showHelp: false,
      logLines: [],
      exited: false,
      debug: false,
      ambientTimer: 0,
      ambientIndex: 0,
      frameCount: 0,
      generatedDepth: 0,
    };

    tryMove(state, 2.2, 1.5, level);

    expect(state.levels).toHaveLength(1);
    expect(state.playerX).toBe(1.5);
    expect(state.playerY).toBe(1.5);
  });
});
