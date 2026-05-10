import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import ResidualHighway from "./ResidualHighway";
import LayerBands from "./LayerBands";
import AttentionRings from "./AttentionRings";
import OutputHead from "./OutputHead";
import TokenParticles from "./TokenParticles";
import type { ResolvedVisualParams } from "../modelRegistry";

interface Props {
  params: ResolvedVisualParams;
  layerCount: number;
  attentionHeads: number;
  streaming: boolean;
  phase: string;
  instability: number;
  cascadeProgress: number;
}

/**
 * Vertical reactor core for dense transformer models.
 *
 * Layout (vertical, along Y axis):
 *   - Central residual spine (bright vertical cylinder)
 *   - Stacked rectangular layer slabs (wide, thin, deep)
 *   - 4 thin attention rings at key positions
 *   - MLP micro-blocks beside each slab
 *   - Context rails on either side
 *   - Token particles flowing down the spine
 *   - Output aperture at the bottom
 */
const TransformerBackbone: React.FC<Props> = ({
  params, layerCount, attentionHeads,
  streaming, phase, instability, cascadeProgress,
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const stackLength = 4.0 * params.scaleMultiplier;  // compact, not 7.2

  // MLP micro-blocks — small boxes beside each layer slab
  const mlpSlabCount = layerCount;
  const mlpOffsetZ = 0.55 * params.scaleMultiplier;
  const slabDummy = useMemo(() => new THREE.Object3D(), []);

  const slabGeo = useMemo(
    () => new THREE.BoxGeometry(0.06, 0.04, 0.15),
    []
  );
  const slabMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(params.baseColor).multiplyScalar(0.6),
        emissive: new THREE.Color(params.baseColor).multiplyScalar(0.6),
        emissiveIntensity: 0.12,
        roughness: 0.5,
        metalness: 0.3,
        transparent: true,
        opacity: 0.6,
      }),
    [params.baseColor]
  );
  const slabMeshRef = useRef<THREE.InstancedMesh>(null);
  const layerSpacing = stackLength / (layerCount - 1);
  const stackStart = -stackLength / 2;

  useMemo(() => {
    if (!slabMeshRef.current) return;
    for (let l = 0; l < mlpSlabCount; l++) {
      slabDummy.position.set(0, stackStart + l * layerSpacing, mlpOffsetZ);
      slabDummy.rotation.set(0, 0, 0);
      slabDummy.scale.setScalar(0.8 + (l % 3) * 0.08);
      slabDummy.updateMatrix();
      slabMeshRef.current.setMatrixAt(l, slabDummy.matrix);
    }
    slabMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [mlpSlabCount, slabDummy, stackStart, layerSpacing, mlpOffsetZ]);

  useFrame((state) => {
    if (!slabMeshRef.current) return;
    const t = state.clock.elapsedTime;
    for (let l = 0; l < mlpSlabCount; l++) {
      const y = stackStart + l * layerSpacing;
      slabDummy.position.set(0, y, mlpOffsetZ);
      slabDummy.scale.set(1, 1 + Math.sin(t * 0.8 + l * 0.2) * 0.1, 1);
      slabDummy.rotation.set(0, 0, Math.sin(t * 0.3 + l * 0.1) * 0.03);
      slabDummy.updateMatrix();
      slabMeshRef.current.setMatrixAt(l, slabDummy.matrix);
    }
    slabMeshRef.current.instanceMatrix.needsUpdate = true;
    slabMat.emissiveIntensity = 0.12 + (streaming ? 0.08 : 0);
  });

  return (
    <group ref={groupRef}>
      {/* Central vertical spine */}
      <ResidualHighway params={params} streaming={streaming} instability={instability} />

      {/* Stacked rectangular layer slabs */}
      <LayerBands
        params={params}
        layerCount={layerCount}
        stackLength={stackLength}
        streaming={streaming}
        instability={instability}
        cascadeProgress={cascadeProgress}
      />

      {/* MLP micro-blocks */}
      <instancedMesh ref={slabMeshRef} args={[slabGeo, slabMat, mlpSlabCount]} />

      {/* 4 attention rings */}
      <AttentionRings
        params={params}
        stackLength={stackLength}
        streaming={streaming}
        phase={phase}
        instability={instability}
        truth="simulated"
      />

      {/* Token particles flowing along spine */}
      <TokenParticles
        params={params}
        stackLength={stackLength}
        streaming={streaming}
        instability={instability}
      />

      {/* Output aperture at bottom */}
      <OutputHead params={params} stackLength={stackLength} streaming={streaming} />
    </group>
  );
};

export default TransformerBackbone;
