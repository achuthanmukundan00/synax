import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { createHologramMaterial, updateShaderTime } from "../../shaders/hologramMaterial";
import type { ResolvedVisualParams } from "../modelRegistry";

interface Props {
  params: ResolvedVisualParams;
  streaming: boolean;
  instability: number;
}

/**
 * Vertical glowing conduit through the center of the transformer stack.
 * Pulses with token flow. The brightest element in the scene.
 */
const ResidualHighway: React.FC<Props> = ({ params, streaming, instability }) => {
  const groupRef = useRef<THREE.Group>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);

  const height = 7.2 * params.scaleMultiplier;

  const coreMat = useMemo(
    () => createHologramMaterial(params.baseColor, params.accentColor, 0.45),
    [params.baseColor, params.accentColor]
  );

  const haloMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: params.accentColor,
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [params.accentColor]
  );

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    updateShaderTime(coreMat, t, streaming ? 0.8 + instability * 0.3 : 0.3);

    if (coreRef.current) {
      const pulse = 1 + Math.sin(t * 2.5) * 0.04 + instability * 0.06;
      coreRef.current.scale.set(1, pulse, pulse);
    }

    if (haloRef.current) {
      haloRef.current.scale.set(1, 1 + Math.sin(t * 1.8) * 0.05, 1 + Math.sin(t * 1.8) * 0.05);
    }

    // Update camera position for fresnel effect
    coreMat.uniforms.uCameraPosition.value.copy(state.camera.position);
  });

  return (
    <group ref={groupRef}>
      {/* Central spine core */}
      <mesh ref={coreRef} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.04, 0.04, height, 16, 1]} />
        <primitive object={coreMat} attach="material" />
      </mesh>

      {/* Spine halo */}
      <mesh ref={haloRef} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.09, 0.09, height - 0.3, 16, 1]} />
        <primitive object={haloMat} attach="material" />
      </mesh>
    </group>
  );
};

export default ResidualHighway;
