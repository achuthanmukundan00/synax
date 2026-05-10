import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ResolvedVisualParams } from "../modelRegistry";

interface Props {
  params: ResolvedVisualParams;
  stackLength: number;
  streaming: boolean;
}

/**
 * Small bright aperture at the bottom of the vertical transformer stack.
 * Tokens emit from here into the transcript stream.
 */
const OutputHead: React.FC<Props> = ({ params, stackLength, streaming }) => {
  const groupRef = useRef<THREE.Group>(null);
  const surfaceRef = useRef<THREE.Mesh>(null);

  const outputY = -stackLength / 2 - 0.3 * params.scaleMultiplier;
  const radius = 0.35 * params.scaleMultiplier;

  const surfaceMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(params.baseColor).multiplyScalar(0.4),
        emissive: params.accentColor,
        emissiveIntensity: 0.5,
        roughness: 0.15,
        metalness: 0.8,
      }),
    [params.baseColor, params.accentColor]
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (surfaceRef.current) {
      const pulse = 1 + Math.sin(t * 3) * 0.06 + (streaming ? 0.1 : 0);
      surfaceRef.current.scale.setScalar(pulse);
    }
    surfaceMat.emissiveIntensity = 0.5 + (streaming ? 0.4 + Math.sin(t * 6) * 0.15 : 0);
  });

  return (
    <group ref={groupRef} position={[0, outputY, 0]}>
      <mesh ref={surfaceRef}>
        <ringGeometry args={[radius * 0.7, radius, 32]} />
        <primitive object={surfaceMat} attach="material" />
      </mesh>
    </group>
  );
};

export default OutputHead;
