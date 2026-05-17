import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SuperSelfModel } from "../packages/super-core/src/self-model.ts";
import { SuperWorld } from "../packages/super-core/src/world.ts";
import { SuperPulse } from "../packages/super-daemon/src/pulse.ts";

const root = await mkdtemp(join(tmpdir(), "super-world-"));

try {
  const world = new SuperWorld(root);
  await world.ensure();

  const self = new SuperSelfModel(world);
  assert.equal(self.canAutoApply(), false);

  const patchPath = await self.proposePatch({
    title: "Tighten self model",
    rationale: "Self changes must be auditable.",
    patch: "--- a/self.md\n+++ b/self.md\n@@\n+Prefer patch suggestions.",
    source: "dream",
  });

  const patch = await readFile(patchPath, "utf8");
  assert.match(patch, /Target: self\.md/);
  assert.match(patch, /Mode: propose_only/);
  assert.match(patch, /Prefer patch suggestions/);

  const pulse = new SuperPulse(world, {
    async run() {
      throw new Error("pulse should skip non-actionable content");
    },
  } as any);
  const result = await pulse.run();
  assert.equal(result.status, "skipped");
} finally {
  await rm(root, { recursive: true, force: true });
}
