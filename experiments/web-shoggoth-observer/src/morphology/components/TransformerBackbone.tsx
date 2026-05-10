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
 * Vertical black-metal reactor core for known dense transformer models.
 *
 * Layout:
 *   - Central residual spine (brightest)
 *   - Stacked translucent layer bands
 *   - Attention rings wrapping layer groups
 *   - Token particles flowing through the stack
 *   - Output head at the bottom
 */
const TransformerBackbone: React.FC<Props> = ({
  params,
  layerCount,
  attentionHeads,
  streaming,
  phase,
  instability,
  cascadeProgress,
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const stackLength = 7.2 * params.scaleMultiplier;

  // MLP slabs offset from attention fibers
  const mlpSlabCount = layerCount;
  const mlpOffsetZ = 0.45 * params.scaleMultiplier;
  const slabDummy = useMemo(() => new THREE.Object3D(), []);

  const slabGeo = useMemo(
    () => new THREE.BoxGeometry(0.08, 0.55 * params.scaleMultiplier, 0.22),
    [params.scaleMultiplier]
  );
  const slabMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(params.baseColor).multiplyScalar(0.7),
        emissive: new THREE.Color(params.baseColor).multiplyScalar(0.7),
        emissiveIntensity: 0.15,
        roughness: 0.5,
        metalness: 0.3,
        transparent: true,
        opacity: 0.7,
      }),
    [params.baseColor]
  );
  const slabMeshRef = useRef<THREE.InstancedMesh>(null);
  const layerSpacing = stackLength / (layerCount - 1);
  const stackStart = -stackLength / 2;

  // Set initial MLP slab positions
  useMemo(() => {
    if (!slabMeshRef.current) return;
    for (let l = 0; l < mlpSlabCount; l++) {
      slabDummy.position.set(stackStart + l * layerSpacing, 0, mlpOffsetZ);
      slabDummy.rotation.set(0, 0, 0);
      slabDummy.scale.setScalar(0.9 + (l % 3) * 0.05);
      slabDummy.updateMatrix();
      slabMeshRef.current.setMatrixAt(l, slabDummy.matrix);
    }
    slabMeshRef.current.instanceMatrix.needsUpdate = true;
  }, [mlpSlabCount, slabDummy, stackStart, layerSpacing, mlpOffsetZ]);

  useFrame((state) => {
    if (!slabMeshRef.current) return;
    const t = state.clock.elapsedTime;
    for (let l = 0; l < mlpSlabCount; l++) {
      const x = stackStart + l * layerSpacing;
      const pulse = 1 + Math.sin(t * 1.1 + l * 0.3) * 0.04;
      slabDummy.position.set(x, 0, mlpOffsetZ);
      slabDummy.scale.set(1, pulse, 1);
      slabDummy.rotation.set(0, 0, Math.sin(t * 0.5 + l * 0.1) * 0.02);
      slabDummy.updateMatrix();
      slabMeshRef.current.setMatrixAt(l, slabDummy.matrix);
    }
    slabMeshRef.current.instanceMatrix.needsUpdate = true;
    slabMat.emissiveIntensity = 0.15 + (streaming ? 0.1 : 0) + instability * 0.08;
  });

  return (
    <group ref={groupRef}>
      {/* Central spine */}
      <ResidualHighway params={params} streaming={streaming} instability={instability} />

      {/* Layer bands (torus stack) */}
      <LayerBands
        params={params}
        layerCount={layerCount}
        stackLength={stackLength}
        streaming={streaming}
        instability={instability}
        cascadeProgress={cascadeProgress}
      />

      {/* MLP slabs */}
      <instancedMesh ref={slabMeshRef} args={[slabGeo, slabMat, mlpSlabCount]} />

      {/* Attention rings + head dots */}
      <AttentionRings
        params={params}
        layerCount={layerCount}
        attentionHeads={attentionHeads}
        stackLength={stackLength}
        streaming={streaming}
        phase={phase}
        instability={instability}
        truth="simulated"
      />

      {/* Token particles */}
      <TokenParticles
        params={params}
        stackLength={stackLength}
        streaming={streaming}
        instability={instability}
      />

      {/* Output head */}
      <OutputHead params={params} stackLength={stackLength} streaming={streaming} />
    </group>
  );
};

export default TransformerBackbone;
