import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntimeStore } from "../runtimeStore";
import { RUNTIME_COLORS } from "../eventTypes";
import type { ShellRisk } from "../eventTypes";

// ─── Tool color mapping ─────────────────────────────────────────────────
const TOOL_COLORS: Record<string, string> = {
  read: RUNTIME_COLORS.toolRead,
  write: RUNTIME_COLORS.toolWrite,
  edit: RUNTIME_COLORS.toolWrite,
  bash: RUNTIME_COLORS.shellCommand,
  search_memory: RUNTIME_COLORS.memory,
  web: "#c084fc",
  subroutine: "#fb923c",
};

const RISK_GLOW: Record<ShellRisk, number> = {
  low: 0.2,
  medium: 0.5,
  high: 1.2,
};

/**
 * Tool-call nodes orbiting around the morphology.
 * Each active tool appears as a glowing node with a beam
 * connecting it back to the core.
 */
const ToolCallNodes: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const activeTool = useRuntimeStore((s) => s.activeTool);
  const recentEvents = useRuntimeStore((s) => s.recentEvents);

  // Track recent tool call events (last 5 seconds)
  const activeTools = useRef<Map<string, { tool: string; risk: ShellRisk; startedAt: number; pos: THREE.Vector3 }>>(new Map());

  // Material cache
  const nodeGeo = useMemo(() => new THREE.IcosahedronGeometry(0.08, 1), []);
  const beamGeo = useMemo(() => new THREE.CylinderGeometry(0.008, 0.008, 1, 6), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const now = performance.now();

    // Clean expired tools (> 8 seconds)
    for (const [key, tool] of activeTools.current) {
      if (now - tool.startedAt > 8000) {
        activeTools.current.delete(key);
      }
    }

    // Add new tool calls from events
    const recentToolCalls = recentEvents.filter(
      (e) => e.type === "tool_call" && now - e.timestamp < 5000
    );
    for (const call of recentToolCalls) {
      if (call.type !== "tool_call") continue;
      const key = `${call.tool}-${call.timestamp}`;
      if (!activeTools.current.has(key)) {
        const angle = Math.random() * Math.PI * 2;
        const r = 1.6 + Math.random() * 0.4;
        activeTools.current.set(key, {
          tool: call.tool,
          risk: call.risk,
          startedAt: call.timestamp,
          pos: new THREE.Vector3(
            Math.cos(angle) * r,
            (Math.random() - 0.5) * 3,
            Math.sin(angle) * r
          ),
        });
      }
    }

    // Render active tool meshes (imperatively for performance)
    if (!groupRef.current) return;
    const group = groupRef.current;
    // Clear children each frame and rebuild (simple approach for < 10 tools)
    while (group.children.length > 0) {
      const child = group.children[0];
      if (child instanceof THREE.Mesh && child.material instanceof THREE.Material) {
        child.material.dispose();
      }
      group.remove(child);
    }

    for (const [key, tool] of activeTools.current) {
      const age = (now - tool.startedAt) / 1000;
      const fadeOut = age > 5 ? 1 - (age - 5) / 3 : 1;
      if (fadeOut <= 0) continue;

      const color = TOOL_COLORS[tool.tool] || RUNTIME_COLORS.tokenFlow;
      const glow = RISK_GLOW[tool.risk] || 0.2;
      const pulseSize = 1 + Math.sin(t * 5) * 0.1;

      // Node
      const nodeMat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.6 + glow,
        roughness: 0.2,
        metalness: 0.6,
        transparent: true,
        opacity: fadeOut,
      });
      const node = new THREE.Mesh(nodeGeo, nodeMat);
      node.position.copy(tool.pos);
      node.scale.setScalar(pulseSize);
      node.rotation.set(t * 0.5, t * 0.7, 0);
      group.add(node);

      // Beam connecting back to core (Y-axis)
      const beamDir = tool.pos.clone().normalize();
      const beamMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: fadeOut * 0.4 * glow,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const midPoint = tool.pos.clone().multiplyScalar(0.5);
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.copy(midPoint);
      beam.lookAt(tool.pos);
      beam.scale.y = tool.pos.length();
      group.add(beam);

      // Risk halos
      if (tool.risk === "high") {
        const haloMat = new THREE.MeshBasicMaterial({
          color: RUNTIME_COLORS.suspicious,
          transparent: true,
          opacity: fadeOut * 0.6 * (0.5 + Math.sin(t * 8) * 0.5),
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const halo = new THREE.Mesh(
          new THREE.TorusGeometry(0.15, 0.01, 8, 16),
          haloMat
        );
        halo.position.copy(tool.pos);
        group.add(halo);
      }
    }
  });

  return <group ref={groupRef} />;
};

export default ToolCallNodes;
