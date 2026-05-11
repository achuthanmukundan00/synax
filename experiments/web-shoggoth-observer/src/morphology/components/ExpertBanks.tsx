import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ResolvedVisualParams } from "../modelRegistry";
import type { SignalTruthLevel } from "../../eventTypes";

interface Props {
  params: ResolvedVisualParams;
  stackLength: number;
  expertBanks: number;
  visibleExperts: number;
  activeExpertsPerToken: number;
  streaming: boolean;
  phase: string;
  instability: number;
  truth: SignalTruthLevel;
}

/**
 * Compact wireframe expert shards arranged in a ring around the central core.
 * Dark glass when inactive, bright emissive flashes when active (80–180 ms).
 * Sparse active routing — only a few experts light per token.
 */
const ExpertBanks: React.FC<Props> = ({
  params, stackLength, expertBanks, visibleExperts,
  activeExpertsPerToken, streaming, phase, instability,
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const shardMeshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const cappedExperts = Math.min(visibleExperts, 256);
  const banks = Math.min(expertBanks, 8);
  const perBank = Math.ceil(cappedExperts / banks);
  const totalShards = Math.min(banks * perBank, cappedExperts);

  // Ring at moderate distance around the core
  const ringRadius = 1.15 * params.scaleMultiplier;
  // Small rectangular shards — thin, wire-like
  const shardW = 0.04;
  const shardH = 0.18;
  const shardD = 0.025;

  const shardGeo = useMemo(() => new THREE.BoxGeometry(shardW, shardH, shardD), []);
  const shardMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(params.baseColor).multiplyScalar(0.3),
        emissive: params.baseColor,
        emissiveIntensity: 0.04,
        roughness: 0.6,
        metalness: 0.3,
        transparent: true,
        opacity: 0.4,
      }),
    [params.baseColor]
  );

  // Positions — even ring + vertical distribution
  const shardData = useMemo(() => {
    const data: { x: number; y: number; z: number; bank: number; idx: number }[] = [];
    for (let b = 0; b < banks; b++) {
      const angle = (b / banks) * Math.PI * 2;
      for (let i = 0; i < perBank; i++) {
        const vi = b * perBank + i;
        if (vi >= cappedExperts) break;
        const r = ringRadius + (i % 3) * 0.08;
        const y = -stackLength / 2 + ((i + 0.5) / perBank) * stackLength;
        data.push({
          x: Math.cos(angle) * r,
          y,
          z: Math.sin(angle) * r,
          bank: b,
          idx: vi,
        });
      }
    }
    return data;
  }, [banks, perBank, cappedExperts, ringRadius, stackLength]);

  useMemo(() => {
    if (!shardMeshRef.current) return;
    shardData.forEach((d, i) => {
      dummy.position.set(d.x, d.y, d.z);
      dummy.lookAt(d.x * 2, d.y, d.z * 2);
      dummy.scale.setScalar(0.7);
      dummy.updateMatrix();
      shardMeshRef.current!.setMatrixAt(i, dummy.matrix);
    });
    shardMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [shardData, dummy]);

  // Track active experts with decay timer
  const activeMap = useRef<Map<number, number>>(new Map()); // idx → activation time
  const routeTimer = useRef(0);
  const ACTIVATION_DURATION = 0.15; // 150ms flash

  useFrame((state) => {
    if (!shardMeshRef.current) return;
    const t = state.clock.elapsedTime;

    // Route new experts when streaming/thinking
    const routeInterval = (streaming || phase === "think") ? 0.12 : 1.2;
    if (t - routeTimer.current > routeInterval) {
      routeTimer.current = t;
      // Clear expired
      for (const [idx, at] of activeMap.current) {
        if (t - at > ACTIVATION_DURATION * 2) activeMap.current.delete(idx);
      }
      // Activate new batch
      const count = (streaming || phase === "think") ? activeExpertsPerToken : 2;
      for (let i = 0; i < count; i++) {
        const ri = Math.floor(Math.random() * totalShards);
        activeMap.current.set(ri, t);
      }
    }

    // Animate shards
    for (let i = 0; i < Math.min(shardData.length, totalShards); i++) {
      const d = shardData[i];
      const actTime = activeMap.current.get(d.idx);
      const isActive = actTime != null && (t - actTime) < ACTIVATION_DURATION;
      const age = actTime != null ? t - actTime : 999;

      // Active: bright flash that decays
      const scale = isActive
        ? 1.0 + Math.max(0, 1 - age / ACTIVATION_DURATION) * 0.6
        : 0.65 + Math.sin(t * 1.0 + i * 0.1) * 0.03;

      dummy.position.set(d.x, d.y, d.z);
      dummy.lookAt(d.x * 2, d.y, d.z * 2);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      shardMeshRef.current.setMatrixAt(i, dummy.matrix);
    }
    shardMeshRef.current.instanceMatrix.needsUpdate = true;

    // Material pulse
    shardMat.emissiveIntensity = 0.04 + (streaming ? 0.12 : 0) + instability * 0.06;
    shardMat.opacity = 0.35 + (streaming ? 0.15 : 0);
  });

  return (
    <group ref={groupRef}>
      <instancedMesh ref={shardMeshRef} args={[shardGeo, shardMat, totalShards]} />
    </group>
  );
};

export default ExpertBanks;
