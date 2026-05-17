import { resolve } from "node:path";

import { SuperRuntime } from "../../../packages/super-core/src/runtime.ts";
import { SuperSynaxSdkAdapter } from "../../../packages/super-core/src/synax-sdk-adapter.ts";
import { SuperWorld } from "../../../packages/super-core/src/world.ts";
import { SuperDaemon } from "../../../packages/super-daemon/src/daemon.ts";

const worldRoot = resolve(process.env.SUPER_WORLD_ROOT ?? "worlds/default");
const model = process.env.SUPER_LLM_BASE_URL && process.env.SUPER_LLM_MODEL
  ? {
      provider: process.env.SUPER_LLM_PROVIDER ?? "custom",
      baseUrl: process.env.SUPER_LLM_BASE_URL,
      model: process.env.SUPER_LLM_MODEL,
      apiKey: process.env.SUPER_LLM_API_KEY ?? "",
      maxTokens: process.env.SUPER_LLM_MAX_TOKENS ? Number(process.env.SUPER_LLM_MAX_TOKENS) : undefined,
      timeoutMs: process.env.SUPER_LLM_TIMEOUT_MS ? Number(process.env.SUPER_LLM_TIMEOUT_MS) : undefined,
    }
  : undefined;

const runtime = new SuperRuntime(
  new SuperWorld(worldRoot),
  new SuperSynaxSdkAdapter({
    model,
    workingDir: process.env.SUPER_WORKING_DIR ?? process.cwd(),
    sessionId: process.env.SUPER_SESSION_ID ?? "super-default",
    mode: process.env.SUPER_SYNAX_MODE ?? "read-only",
    bashEnabled: process.env.SUPER_ENABLE_BASH === "true",
  }),
);

const daemon = new SuperDaemon(runtime);
daemon.start();

console.log(JSON.stringify({
  ok: true,
  service: "superd",
  worldRoot,
  synaxConfigured: Boolean(model),
  status: daemon.status(),
}));
