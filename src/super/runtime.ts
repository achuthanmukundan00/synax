import type { SuperRunRequest, SuperRunResult, SynaxRuntimeLike } from './types';
import { SuperWorld } from './world';

/**
 * SuperRuntime — wraps a SynaxRuntime-like executor with world/self/pulse context.
 *
 * This is the integration point between the Synax SDK runtime and the Super
 * cognitive layer (world model, self model, reflections, patch proposals).
 */
export class SuperRuntime {
  private readonly world: SuperWorld;
  private readonly synax: SynaxRuntimeLike;

  constructor(world: SuperWorld, synax: SynaxRuntimeLike) {
    this.world = world;
    this.synax = synax;
  }

  async run(request: SuperRunRequest): Promise<SuperRunResult> {
    await this.world.ensure();
    const context = await this.world.readContext();
    const prompt = buildSuperPrompt(request, context);
    const result = await this.synax.run({
      input: request.input ?? '',
      context: prompt,
      sessionId: request.sessionId,
    });

    if (result.status !== 'completed') {
      return { status: 'failed', error: result.error || `Synax status: ${result.status}` };
    }

    return {
      status: 'completed',
      response: result.output,
      actionPlan: {
        summary: 'Super completed a bounded run through Synax.',
        actions: [],
      },
    };
  }
}

function buildSuperPrompt(request: SuperRunRequest, context: { self: string; world: string; pulse: string }): string {
  // Identity, security, and behavioral rules are owned by the Synax system prompt.
  // Do NOT inject competing identities ("You are Super", etc.) — that creates
  // prompt injection surface by giving the model two names/role descriptions.
  const lines: string[] = [];

  lines.push(`Run kind: ${request.kind}`);
  if (request.source) lines.push(`Source: ${request.source}`);
  if (request.conversationId) lines.push(`Conversation: ${request.conversationId}`);

  if (context.self) {
    lines.push('');
    lines.push('## self.md');
    lines.push(context.self);
  }
  if (context.world) {
    lines.push('');
    lines.push('## world.md');
    lines.push(context.world);
  }
  if (context.pulse) {
    lines.push('');
    lines.push('## pulse.md');
    lines.push(context.pulse);
  }

  return lines.join('\n');
}
