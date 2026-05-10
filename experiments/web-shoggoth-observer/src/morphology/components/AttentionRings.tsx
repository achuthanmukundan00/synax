import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ResolvedVisualParams } from "../modelRegistry";
import type { SignalTruthLevel } from "../../eventTypes";

interface Props {
  params: ResolvedVisualParams;
  stackLength: number;
  streaming: boolean;
  phase: string;
  instability: number;
  truth: SignalTruthLevel;
}

/**
 * A few thin elliptical rings wrapping around the vertical core.
 * Not one per layer — just 3–4 accent rings at key positions.
 * These represent attention-like channels conceptually.
 */
const AttentionRings: React.FC<Props> = ({
  params, stackLength, streaming, phase, instability,
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const ringCount = 4;
  const ringRadius = 1.15 * params.scaleMultiplier;

  const ringMeshes = useRef<THREE.Mesh[]>([]);

  const ringData = useMemo(() => {
    return Array.from({ length: ringCount }, (_, i) => {
      const y = -stackLength / 2 + ((i + 0.5) / ringCount) * stackLength;
      const geo = new THREE.TorusGeometry(ringRadius, 0.008 * params.scaleMultiplier, 8, 64);
      const mat = new THREE.MeshBasicMaterial({
        color: params.accentColor,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      return { y, geo, mat, tilt: Math.PI / 2.5 + i * 0.2, speed: 0.3 + i * 0.15 };
    });
  }, [ringCount, ringRadius, stackLength, params]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    ringMeshes.current.forEach((ring, i) => {
      if (!ring) return;
      const rd = ringData[i];
      const thinkBoost = phase === "think" || streaming ? 1.5 : 1;
      ring.rotation.z += 0.005 * rd.speed * thinkBoost;
      ring.rotation.x += 0.002 * rd.speed * thinkBoost;
      rd.mat.opacity = 0.22 + (streaming ? 0.1 : 0) + instability * 0.05;
    });
  });

  return (
    <group ref={groupRef}>
      {ringData.map((rd, i) => (
        <mesh
          key={`aring-${i}`}
          ref={(el) => { ringMeshes.current[i] = el!; }}
          geometry={rd.geo}
          material={rd.mat}
          position={[0, rd.y, 0]}
          rotation={[rd.tilt, 0, 0]}
        />
      ))}
    </group>
  );
};

export default AttentionRings;
