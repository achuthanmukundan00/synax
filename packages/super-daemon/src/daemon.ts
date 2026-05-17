import type { SuperRunRequest, SuperRunResult } from "../../super-core/src/types.ts";
import { SuperRuntime } from "../../super-core/src/runtime.ts";

export type SuperDaemonState = "stopped" | "starting" | "running" | "stopping" | "error";

export type SuperDaemonStatus = {
  state: SuperDaemonState;
  error?: string;
  startedAt?: string;
  messageCount: number;
};

export class SuperDaemon {
  private readonly runtime: SuperRuntime;
  private state: SuperDaemonState = "stopped";
  private error = "";
  private startedAt = "";
  private messageCount = 0;
  private readonly seenInboundIds = new Set<string>();
  private runLock: Promise<SuperRunResult> | null = null;

  constructor(runtime: SuperRuntime) {
    this.runtime = runtime;
  }

  start(): SuperDaemonStatus {
    if (this.state === "running") return this.status();
    this.state = "running";
    this.error = "";
    this.startedAt = new Date().toISOString();
    return this.status();
  }

  stop(): SuperDaemonStatus {
    this.state = "stopped";
    this.startedAt = "";
    return this.status();
  }

  status(): SuperDaemonStatus {
    return {
      state: this.state,
      error: this.error || undefined,
      startedAt: this.startedAt || undefined,
      messageCount: this.messageCount,
    };
  }

  async handleInbound(id: string, request: SuperRunRequest): Promise<SuperRunResult> {
    if (this.seenInboundIds.has(id)) return { status: "skipped", response: "duplicate inbound message" };
    this.seenInboundIds.add(id);
    if (this.state !== "running") return { status: "failed", error: "Super daemon is not running" };
    if (this.runLock) return { status: "skipped", response: "conversation is already being handled" };

    this.runLock = this.runtime.run(request);
    try {
      const result = await this.runLock;
      this.messageCount += 1;
      return result;
    } catch (error) {
      this.state = "error";
      this.error = error instanceof Error ? error.message : String(error);
      return { status: "failed", error: this.error };
    } finally {
      this.runLock = null;
    }
  }
}
