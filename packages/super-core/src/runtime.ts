import type { SuperRunRequest, SuperRunResult, SynaxRuntimeLike } from "./types.ts";
import { SuperWorld } from "./world.ts";

export class SuperRuntime {
  private readonly world: SuperWorld;
  private readonly synax: SynaxRuntimeLike;

  constructor(
    world: SuperWorld,
    synax: SynaxRuntimeLike,
  ) {
    this.world = world;
    this.synax = synax;
  }

  async run(request: SuperRunRequest): Promise<SuperRunResult> {
    await this.world.ensure();
    const context = await this.world.readContext();
    const prompt = buildSuperPrompt(request, context);
    const result = await this.synax.run({ input: request.input ?? "", context: prompt });

    if (result.status !== "completed") {
      return { status: "failed", error: result.error || `Synax status: ${result.status}` };
    }

    return {
      status: "completed",
      response: result.output,
      actionPlan: {
        summary: "Super completed a bounded run through Synax.",
        actions: [],
      },
    };
  }
}

function buildSuperPrompt(
  request: SuperRunRequest,
  context: { self: string; world: string; pulse: string },
): string {
  return [
    "You are Super, a bounded career/life operating agent built on Synax.",
    "Act as a trusted friend, secretary, career strategist, digest generator, memory consolidator, and action planner.",
    "Do not claim actions were completed unless they were actually completed by available tools.",
    "Do not browse or automate accounts without explicit user permission.",
    "Do not rewrite self.md directly. Propose patches for review unless auto-apply is explicitly configured outside this prompt.",
    "",
    `Run kind: ${request.kind}`,
    request.source ? `Source: ${request.source}` : "",
    request.conversationId ? `Conversation: ${request.conversationId}` : "",
    "",
    "## self.md",
    context.self,
    "",
    "## world.md",
    context.world,
    "",
    "## pulse.md",
    context.pulse,
  ].filter(Boolean).join("\n");
}
