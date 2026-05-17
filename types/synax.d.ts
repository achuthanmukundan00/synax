declare module "synax" {
  export class SynaxRuntime {
    constructor(config: unknown);
    run(input: { input: string; context?: string; signal?: AbortSignal; sessionId?: string }): Promise<{
      status: string;
      output: string;
      error?: string;
      filesChanged?: string[];
      toolCalls?: number;
      steps?: number;
    }>;
  }
}
