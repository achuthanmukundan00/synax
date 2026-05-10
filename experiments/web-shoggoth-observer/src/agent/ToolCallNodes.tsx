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

interface ToolEntry {
  tool: string;
  risk: ShellRisk;
  startedAt: number;
  pos: THREE.Vector3;
  node: THREE.Mesh;
  beam: THREE.Mesh;
  halo?: THREE.Mesh;
  nodeMat: THREE.MeshStandardMaterial;
  beamMat: THREE.MeshBasicMaterial;
  haloMat?: THREE.MeshBasicMaterial;
}

/**
 * Tool-call nodes orbiting around the morphology.
 * Each active tool appears as a glowing node with a beam
 * connecting it back to the core.
 *
 * Uses persistent refs — creates meshes once when a tool appears,
 * only updates transforms in useFrame. No per-frame destruction.
 */
const ToolCallNodes: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const recentEvents = useRuntimeStore((s) => s.recentEvents);

  // Persistent tool entries keyed by unique tool+timestamp
  const toolsRef = useRef<Map<string, ToolEntry>>(new Map());

  // Cached geometries (shared by all tool nodes)
  const nodeGeo = useMemo(() => new THREE.IcosahedronGeometry(0.08, 1), []);
  const beamGeo = useMemo(() => new THREE.CylinderGeometry(0.008, 0.008, 1, 6), []);
  const haloGeo = useMemo(() => new THREE.TorusGeometry(0.15, 0.01, 8, 16), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const now = performance.now();
    const grp = groupRef.current;
    if (!grp) return;

    // ── Add new tool calls from recent events ────────────────────────────
    const recentToolCalls = recentEvents.filter(
      (e) => e.type === "tool_call" && now - e.timestamp < 5000
    );
    for (const call of recentToolCalls) {
      if (call.type !== "tool_call") continue;
      const key = `${call.tool}-${call.timestamp}`;
      if (toolsRef.current.has(key)) continue;

      const angle = Math.random() * Math.PI * 2;
      const r = 1.6 + Math.random() * 0.4;
      const pos = new THREE.Vector3(
        Math.cos(angle) * r,
        (Math.random() - 0.5) * 3,
        Math.sin(angle) * r
      );
      const color = TOOL_COLORS[call.tool] || RUNTIME_COLORS.tokenFlow;

      // Create node mesh
      const nodeMat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.6 + (RISK_GLOW[call.risk] || 0.2),
        roughness: 0.2,
        metalness: 0.6,
        transparent: true,
        opacity: 1,
      });
      const node = new THREE.Mesh(nodeGeo, nodeMat);
      node.position.copy(pos);
      grp.add(node);

      // Create beam mesh
      const beamMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.4 * (RISK_GLOW[call.risk] || 0.2),
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      const midPoint = pos.clone().multiplyScalar(0.5);
      beam.position.copy(midPoint);
      beam.scale.y = pos.length();
      beam.lookAt(pos);
      grp.add(beam);

      // Risk halo
      let halo: THREE.Mesh | undefined;
      let haloMat: THREE.MeshBasicMaterial | undefined;
      if (call.risk === "high") {
        haloMat = new THREE.MeshBasicMaterial({
          color: RUNTIME_COLORS.suspicious,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        halo = new THREE.Mesh(haloGeo, haloMat);
        halo.position.copy(pos);
        grp.add(halo);
      }

      toolsRef.current.set(key, {
        tool: call.tool,
        risk: call.risk,
        startedAt: call.timestamp,
        pos,
        node,
        beam,
        halo,
        nodeMat,
        beamMat,
        haloMat,
      });
    }

    // ── Update existing tools + remove expired ───────────────────────────
    const expired: string[] = [];
    for (const [key, tool] of toolsRef.current) {
      const age = (now - tool.startedAt) / 1000;
      if (age > 8) {
        expired.push(key);
        continue;
      }

      const fadeOut = age > 5 ? Math.max(0, 1 - (age - 5) / 3) : 1;
      const color = TOOL_COLORS[tool.tool] || RUNTIME_COLORS.tokenFlow;
      const pulseSize = 1 + Math.sin(t * 5) * 0.1;

      // Update node
      tool.node.position.copy(tool.pos);
      tool.node.scale.setScalar(pulseSize);
      tool.node.rotation.set(t * 0.5, t * 0.7, 0);
      tool.nodeMat.opacity = fadeOut;
      tool.nodeMat.emissiveIntensity = 0.6 + (RISK_GLOW[tool.risk] || 0.2) * fadeOut;

      // Update beam
      tool.beamMat.opacity = fadeOut * 0.4 * (RISK_GLOW[tool.risk] || 0.2);

      // Update halo
      if (tool.halo && tool.haloMat) {
        tool.halo.position.copy(tool.pos);
        tool.haloMat.opacity = fadeOut * 0.6 * (0.5 + Math.sin(t * 8) * 0.5);
      }
    }

    // Remove expired
    for (const key of expired) {
      const tool = toolsRef.current.get(key);
      if (tool) {
        grp.remove(tool.node);
        grp.remove(tool.beam);
        if (tool.halo) grp.remove(tool.halo);
        tool.nodeMat.dispose();
        tool.beamMat.dispose();
        if (tool.haloMat) tool.haloMat.dispose();
      }
      toolsRef.current.delete(key);
    }
  });

  return <group ref={groupRef} />;
};

export default ToolCallNodes;
