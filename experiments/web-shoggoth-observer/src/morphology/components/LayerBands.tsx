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
 * Each band is a BoxGeometry slab — wide, thin, deep — like compute plates.
 * Stacked vertically along Y axis.
 */
const LayerBands: React.FC<Props> = ({
  params, layerCount, stackLength, streaming, instability, cascadeProgress,
}) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const layerSpacing = stackLength / (layerCount - 1);
  const stackStart = -stackLength / 2;

  // Rectangular slab — wide (X), thin (Y), deep (Z)
  const slabWidth = 2.0 * params.scaleMultiplier;
  const slabHeight = 0.06 * params.scaleMultiplier;
  const slabDepth = 0.9 * params.scaleMultiplier;

  const geo = useMemo(
    () => new THREE.BoxGeometry(slabWidth, slabHeight, slabDepth),
    [slabWidth, slabHeight, slabDepth]
  );

  const mat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: params.baseColor,
        emissive: params.baseColor,
        emissiveIntensity: 0.2,
        roughness: 0.35,
        metalness: 0.5,
        transparent: true,
        opacity: 0.75,
      }),
    [params.baseColor]
  );

  // Set initial positions along Y
  useMemo(() => {
    if (!meshRef.current) return;
    for (let l = 0; l < layerCount; l++) {
      dummy.position.set(0, stackStart + l * layerSpacing, 0);
      dummy.rotation.set(0, 0, 0);
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
      const y = stackStart + l * layerSpacing;
      const wobble = 1 + Math.sin(t * 0.8 + l * 0.2) * 0.03;

      const layerNorm = l / (layerCount - 1);
      const distToWave = Math.abs(layerNorm - cascadeProgress);
      const cascadeBoost = Math.max(0, 1 - distToWave * 4) * 0.12;

      dummy.position.set(0, y, 0);
      dummy.rotation.set(0, 0, Math.sin(t * 0.3 + l * 0.1) * 0.03);
      dummy.scale.set(1, wobble + cascadeBoost, 1);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(l, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;

    mat.emissiveIntensity = 0.2 + (streaming ? 0.15 : 0) + Math.sin(t * 1.5) * 0.05 + instability * 0.15;
  });

  return <instancedMesh ref={meshRef} args={[geo, mat, layerCount]} />;
};

export default LayerBands;
