import type { SynaxRuntimeLike } from "./types.ts";

export type SuperSynaxSdkAdapterConfig = {
  model?: unknown;
  memory?: unknown;
  tools?: unknown[];
  policy?: unknown;
  workingDir?: string;
  sessionId?: string;
  mode?: string;
  bashEnabled?: boolean;
  contextBudget?: unknown;
  maxOutputTokens?: number;
  onEvent?: (event: unknown) => void;
};

export class SuperSynaxSdkAdapter implements SynaxRuntimeLike {
  private readonly config: SuperSynaxSdkAdapterConfig;
  private runtimePromise: Promise<{ run(input: { input: string; context?: string }): Promise<unknown> }> | null = null;

  constructor(config: SuperSynaxSdkAdapterConfig) {
    this.config = config;
  }

  async run(input: { input: string; context?: string }): Promise<{
    status: string;
    output: string;
    error?: string;
  }> {
    const runtime = await this.runtime();
    const result = await runtime.run(input) as {
      status?: string;
      output?: string;
      error?: string;
    };

    return {
      status: result.status ?? "error",
      output: result.output ?? "",
      error: result.error,
    };
  }

  private runtime(): Promise<{ run(input: { input: string; context?: string }): Promise<unknown> }> {
    this.runtimePromise ??= createSynaxRuntime(this.config);
    return this.runtimePromise;
  }
}

async function createSynaxRuntime(config: SuperSynaxSdkAdapterConfig): Promise<{
  run(input: { input: string; context?: string }): Promise<unknown>;
}> {
  try {
    const { SynaxRuntime } = await import("synax");
    return new SynaxRuntime({
      model: config.model,
      memory: config.memory,
      tools: config.tools,
      policy: config.policy,
      workingDir: config.workingDir,
      sessionId: config.sessionId,
      mode: config.mode ?? "read-only",
      bashEnabled: config.bashEnabled ?? false,
      contextBudget: config.contextBudget,
      maxOutputTokens: config.maxOutputTokens,
      onEvent: config.onEvent,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Super could not load the Synax SDK. Install/build synax before starting Super. ${detail}`);
  }
}
