import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ResolvedVisualParams } from "../modelRegistry";

interface Props {
  params: ResolvedVisualParams;
  layerCount: number;
  stackLength: number;
  streaming: boolean;
  instability: number;
  cascadeProgress: number;
}

/**
 * Stacked translucent rectangular slabs representing transformer layer groups.
 * Each band is an InstancedMesh torus — clean, metallic, architectural.
 */
const LayerBands: React.FC<Props> = ({ params, layerCount, stackLength, streaming, instability, cascadeProgress }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const layerSpacing = stackLength / (layerCount - 1);
  const stackStart = -stackLength / 2;
  const ringRadius = 0.65 * params.scaleMultiplier;

  const mat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: params.baseColor,
        emissive: params.baseColor,
        emissiveIntensity: 0.25,
        roughness: 0.35,
        metalness: 0.5,
        transparent: true,
        opacity: 0.8,
      }),
    [params.baseColor]
  );

  // Geometry
  const geo = useMemo(
    () => new THREE.TorusGeometry(ringRadius, 0.015, 12, 48),
    [ringRadius]
  );

  // Set instance matrices once for positions, animate scale/rotation per frame
  useMemo(() => {
    if (!meshRef.current) return;
    for (let l = 0; l < layerCount; l++) {
      dummy.position.set(stackStart + l * layerSpacing, 0, 0);
      dummy.rotation.set(0, Math.PI / 2, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(l, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [layerCount, layerSpacing, stackStart, dummy]);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;

    for (let l = 0; l < layerCount; l++) {
      const x = stackStart + l * layerSpacing;
      const wobble = 1 + Math.sin(t * 1.3 + l * 0.4) * 0.02;

      // Cascade wave — layers near the wave front expand
      const layerNorm = l / (layerCount - 1);
      const distToWave = Math.abs(layerNorm - cascadeProgress);
      const cascadeBoost = Math.max(0, 1 - distToWave * 4) * 0.08;

      dummy.position.set(x, 0, 0);
      dummy.rotation.set(0, Math.PI / 2 + Math.sin(t * 0.7 + l * 0.2) * 0.03, 0);
      dummy.scale.setScalar(wobble + cascadeBoost + instability * 0.01);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(l, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;

    // Emissive pulses with streaming
    mat.emissiveIntensity = 0.25 + (streaming ? 0.15 : 0) + Math.sin(t * 1.5) * 0.05 + instability * 0.2;
  });

  return <instancedMesh ref={meshRef} args={[geo, mat, layerCount]} />;
};

export default LayerBands;
