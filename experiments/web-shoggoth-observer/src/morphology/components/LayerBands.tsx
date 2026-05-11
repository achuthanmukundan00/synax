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
 * Thin wireframe-like rectangular plates stacked vertically.
 * Each slab is an accent-colored translucent glass plate — not a solid block.
 * Small, subtle, layered — readable as transformer compute layers.
 */
const LayerBands: React.FC<Props> = ({
  params, layerCount, stackLength, streaming, instability, cascadeProgress,
}) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const layerSpacing = stackLength / (layerCount - 1);
  const stackStart = -stackLength / 2;

  // Thin plate — narrow width, very thin height, moderate depth
  const w = 1.0 * params.scaleMultiplier;
  const h = 0.015 * params.scaleMultiplier;
  const d = 0.35 * params.scaleMultiplier;

  const geo = useMemo(() => new THREE.BoxGeometry(w, h, d), [w, h, d]);

  const mat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(params.baseColor).multiplyScalar(0.35),
        emissive: params.baseColor,
        emissiveIntensity: 0.08,
        roughness: 0.5,
        metalness: 0.3,
        transparent: true,
        opacity: 0.45,
      }),
    [params.baseColor]
  );

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
      const layerNorm = l / (layerCount - 1);
      const distToWave = Math.abs(layerNorm - cascadeProgress);
      const cascadeBoost = Math.max(0, 1 - distToWave * 6) * 0.3;

      dummy.position.set(0, y, 0);
      dummy.rotation.set(0, 0, Math.sin(t * 0.3 + l * 0.1) * 0.02);
      dummy.scale.set(1 + cascadeBoost * 0.5, 1 + cascadeBoost * 3, 1);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(l, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;

    mat.emissiveIntensity = 0.08 + (streaming ? 0.1 : 0) + instability * 0.08;
    mat.opacity = 0.4 + (streaming ? 0.15 : 0) + cascadeProgress * 0.1;
  });

  return <instancedMesh ref={meshRef} args={[geo, mat, layerCount]} />;
};

export default LayerBands;
