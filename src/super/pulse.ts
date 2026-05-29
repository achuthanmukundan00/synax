import { readFile } from 'node:fs/promises';

import type { SuperRunResult } from './types';
import { SuperRuntime } from './runtime';
import { SuperWorld } from './world';

export class SuperPulse {
  private readonly world: SuperWorld;
  private readonly runtime: SuperRuntime;

  constructor(world: SuperWorld, runtime: SuperRuntime) {
    this.world = world;
    this.runtime = runtime;
  }

  async run(): Promise<SuperRunResult> {
    const pulse = (await readFile(this.world.paths.pulse, 'utf8').catch(() => '')).trim();
    if (!hasActionablePulse(pulse)) return { status: 'skipped', response: 'pulse has no actionable content' };

    const result = await this.runtime.run({ kind: 'pulse', input: pulse, source: 'pulse.md' });
    if (result.response?.trim() === 'PULSE_OK') return { status: 'skipped', response: 'PULSE_OK' };
    return result;
  }
}

function hasActionablePulse(text: string): boolean {
  if (!text) return false;
  return /\b(todo|check|follow up|deadline|question|review|digest|plan|action)\b/i.test(text);
}
