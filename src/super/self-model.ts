import type { SuperPatchSuggestion } from './types';
import { SuperWorld } from './world';

export type SuperSelfModelOptions = {
  allowAutoApply?: boolean;
};

export class SuperSelfModel {
  private readonly world: SuperWorld;
  private readonly allowAutoApply: boolean;

  constructor(world: SuperWorld, options: SuperSelfModelOptions = {}) {
    this.world = world;
    this.allowAutoApply = options.allowAutoApply ?? false;
  }

  async proposePatch(
    input: Omit<SuperPatchSuggestion, 'target' | 'createdAt' | 'mode'> & {
      target?: SuperPatchSuggestion['target'];
      createdAt?: string;
      mode?: SuperPatchSuggestion['mode'];
    },
  ): Promise<string> {
    return this.world.writePatchSuggestion({
      target: input.target ?? 'self.md',
      title: input.title,
      rationale: input.rationale,
      patch: input.patch,
      source: input.source,
      mode: input.mode ?? 'propose_only',
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
  }

  canAutoApply(): boolean {
    return this.allowAutoApply;
  }
}
