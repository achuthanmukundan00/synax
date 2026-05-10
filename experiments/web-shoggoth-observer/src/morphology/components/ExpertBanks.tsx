import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { RUNTIME_COLORS } from "../../eventTypes";
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
 * Radial or side-mounted rectangular expert shards.
 * Only active expert paths light per token.
 * Inactive experts remain dark glass.
 * If routing data is unavailable, selection is simulated.
 */
const ExpertBanks: React.FC<Props> = ({
  params,
  stackLength,
  expertBanks,
  visibleExperts,
  activeExpertsPerToken,
  streaming,
  phase,
  instability,
  truth,
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const shardMeshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // Limit visible experts for performance
  const cappedExperts = Math.min(visibleExperts, 512);
  const expertsPerBank = Math.ceil(cappedExperts / expertBanks);

  const bankRadius = 1.8 * params.scaleMultiplier;
  const shardWidth = 0.06;
  const shardHeight = 0.25;
  const shardDepth = 0.04;

  const shardGeo = useMemo(() => new THREE.BoxGeometry(shardWidth, shardHeight, shardDepth), []);
  const shardMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: params.baseColor,
        emissive: params.baseColor,
        emissiveIntensity: 0.05,
        roughness: 0.5,
        metalness: 0.5,
        transparent: true,
        opacity: 0.6,
      }),
    [params.baseColor]
  );

  // Shard positions — radial banks around the core
  const shardData = useMemo(() => {
    const data: { x: number; y: number; z: number; bankIndex: number; visualIndex: number }[] = [];
    for (let b = 0; b < expertBanks; b++) {
      const bankAngle = (b / expertBanks) * Math.PI * 2;
      const bx = Math.cos(bankAngle) * bankRadius;
      const bz = Math.sin(bankAngle) * bankRadius;
      for (let e = 0; e < expertsPerBank; e++) {
        const vi = b * expertsPerBank + e;
        if (vi >= cappedExperts) break;
        const y = -stackLength / 2 + (e / (expertsPerBank - 1)) * stackLength;
        data.push({ x: bx, y, z: bz, bankIndex: b, visualIndex: vi });
      }
    }
    return data;
  }, [expertBanks, expertsPerBank, cappedExperts, bankRadius, stackLength]);

  // Set initial instance positions
  useMemo(() => {
    if (!shardMeshRef.current) return;
    shardData.forEach((d, i) => {
      const lookAngle = Math.atan2(d.z, d.x);
      dummy.position.set(d.x, d.y, d.z);
      dummy.rotation.set(0, -lookAngle + Math.PI / 2, 0);
      dummy.scale.setScalar(0.8);
      dummy.updateMatrix();
      shardMeshRef.current!.setMatrixAt(i, dummy.matrix);
    });
    shardMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [shardData, dummy]);

  // Active expert state (simulated when truth is "simulated")
  const activeExpertsRef = useRef<Set<number>>(new Set());
  const lastRoutingTime = useRef(0);

  useFrame((state) => {
    if (!shardMeshRef.current) return;
    const t = state.clock.elapsedTime;

    // Simulate expert routing every ~200ms when streaming
    if (streaming || phase === "think") {
      if (t - lastRoutingTime.current > 0.15 + Math.random() * 0.1) {
        lastRoutingTime.current = t;
        activeExpertsRef.current.clear();
        for (let i = 0; i < activeExpertsPerToken; i++) {
          activeExpertsRef.current.add(Math.floor(Math.random() * cappedExperts));
        }
      }
    } else {
      // Idle: occasional random activation
      if (t - lastRoutingTime.current > 1.5) {
        lastRoutingTime.current = t;
        activeExpertsRef.current.clear();
        for (let i = 0; i < Math.floor(activeExpertsPerToken * 0.3); i++) {
          activeExpertsRef.current.add(Math.floor(Math.random() * cappedExperts));
        }
      }
    }

    // Animate shards: active shards get brighter
    const activeSet = activeExpertsRef.current;
    for (let i = 0; i < Math.min(shardData.length, cappedExperts); i++) {
      const d = shardData[i];
      const isActive = activeSet.has(d.visualIndex);
      const targetScale = isActive ? 1.2 : 0.8 + Math.sin(t * 1.5 + i * 0.1) * 0.05;
      const lookAngle = Math.atan2(d.z, d.x);
      dummy.position.set(d.x, d.y, d.z);
      dummy.rotation.set(0, -lookAngle + Math.PI / 2, 0);
      dummy.scale.setScalar(targetScale);
      dummy.updateMatrix();
      shardMeshRef.current.setMatrixAt(i, dummy.matrix);
    }
    shardMeshRef.current.instanceMatrix.needsUpdate = true;

    // Emissive pulses with activity
    shardMat.emissiveIntensity = 0.05 + (streaming ? 0.15 : 0) + instability * 0.1;
  });

  return (
    <group ref={groupRef}>
      <instancedMesh ref={shardMeshRef} args={[shardGeo, shardMat, shardData.length]} />
    </group>
  );
};

export default ExpertBanks;
