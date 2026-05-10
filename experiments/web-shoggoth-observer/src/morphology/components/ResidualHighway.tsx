import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ResolvedVisualParams } from "../modelRegistry";

interface Props {
  params: ResolvedVisualParams;
  streaming: boolean;
  instability: number;
}

/**
 * Vertical glowing conduit through the center of the transformer stack.
 * Emissive cylinder along Y axis, no rotation.
 */
const ResidualHighway: React.FC<Props> = ({ params, streaming, instability }) => {
  const groupRef = useRef<THREE.Group>(null);
  const coreRef = useRef<THREE.Mesh>(null);

  const height = 4.2 * params.scaleMultiplier;

  const coreMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: params.baseColor,
        emissive: params.baseColor,
        emissiveIntensity: 0.7,
        roughness: 0.2,
        metalness: 0.6,
        transparent: true,
        opacity: 0.7,
      }),
    [params.baseColor]
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (coreRef.current) {
      const pulse = 1 + Math.sin(t * 2.5) * 0.04 + instability * 0.06;
      coreRef.current.scale.set(pulse, 1, pulse);
    }
    coreMat.emissiveIntensity = 0.7 + (streaming ? 0.3 : 0) + Math.sin(t * 2) * 0.1;
  });

  return (
    <group ref={groupRef}>
      <mesh ref={coreRef}>
        <cylinderGeometry args={[0.03, 0.03, height, 16, 1]} />
        <primitive object={coreMat} attach="material" />
      </mesh>
    </group>
  );
};

export default ResidualHighway;
