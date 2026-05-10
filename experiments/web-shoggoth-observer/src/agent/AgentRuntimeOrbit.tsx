import React from "react";
import ToolCallNodes from "./ToolCallNodes";
import MemoryCrystal from "./MemoryCrystal";
import FileGraph from "./FileGraph";
import VerificationRing from "./VerificationRing";
import SuspicionCage from "./SuspicionCage";

/**
 * Root container for all agent runtime visualizations that orbit around
 * the central model morphology:
 *
 *   - Tool call nodes (colored by tool type + risk)
 *   - Memory crystal (green FTS5 archive)
 *   - File graph (orbiting file nodes by activity)
 *   - Verification ring (violet test ring)
 *   - Suspicion cage (red containment for risky commands)
 */
const AgentRuntimeOrbit: React.FC = () => {
  return (
    <>
      <ToolCallNodes />
      <MemoryCrystal />
      <FileGraph />
      <VerificationRing />
      <SuspicionCage />
    </>
  );
};

export default AgentRuntimeOrbit;
