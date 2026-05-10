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
 * Bright aperture at the output end of the transformer.
 * Tokens emit from here into the transcript stream.
 * Pulses with each token.
 */
const OutputHead: React.FC<Props> = ({ params, stackLength, streaming }) => {
  const groupRef = useRef<THREE.Group>(null);
  const surfaceRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);

  const outputX = stackLength / 2 + 0.35 * params.scaleMultiplier;
  const radius = 0.55 * params.scaleMultiplier;

  const surfaceMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(params.baseColor).multiplyScalar(0.4),
        emissive: params.baseColor,
        emissiveIntensity: 0.4,
        roughness: 0.2,
        metalness: 0.7,
      }),
    [params.baseColor]
  );

  const haloMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: params.accentColor,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [params.accentColor]
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    if (surfaceRef.current) {
      const pulse = 1 + Math.sin(t * 3) * 0.06 + (streaming ? 0.08 : 0);
      surfaceRef.current.scale.setScalar(pulse);
    }
    if (haloRef.current) {
      haloRef.current.rotation.z += 0.02;
      const haloPulse = streaming ? 0.35 : 0.18;
      haloMat.opacity += (haloPulse - haloMat.opacity) * 0.1;
    }
    surfaceMat.emissiveIntensity = 0.4 + (streaming ? 0.3 + Math.sin(t * 6) * 0.15 : 0);
  });

  return (
    <group ref={groupRef} position={[outputX, 0, 0]}>
      {/* Output disc */}
      <mesh ref={surfaceRef} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[radius, radius, 0.03, 32]} />
        <primitive object={surfaceMat} attach="material" />
      </mesh>

      {/* Glow halo */}
      <mesh ref={haloRef} rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[radius + 0.05, 0.008, 8, 48]} />
        <primitive object={haloMat} attach="material" />
      </mesh>
    </group>
  );
};

export default OutputHead;
