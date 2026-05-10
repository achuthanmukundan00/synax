import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ResolvedVisualParams } from "../modelRegistry";
import type { SignalTruthLevel } from "../../eventTypes";

interface Props {
  params: ResolvedVisualParams;
  layerCount: number;
  attentionHeads: number;
  stackLength: number;
  streaming: boolean;
  phase: string;
  instability: number;
  truth: SignalTruthLevel;
}

/**
 * Thin rotating elliptical rings around layer groups.
 * Represent attention-like channels. For opaque models, these are
 * inner-layer approximation arcs — marked as "simulated".
 */
const AttentionRings: React.FC<Props> = ({
  params,
  layerCount,
  attentionHeads,
  stackLength,
  streaming,
  phase,
  instability,
}) => {
  const groupRef = useRef<THREE.Group>(null);

  const layerSpacing = stackLength / (layerCount - 1);
  const stackStart = -stackLength / 2;
  const ringRadius = 0.65 * params.scaleMultiplier;
  const fiberOuterRadius = 1.1 * params.scaleMultiplier;

  // Precompute fiber directions
  const fiberDirs = useMemo(() => {
    const dirs = new Float32Array(layerCount * attentionHeads * 2);
    for (let l = 0; l < layerCount; l++) {
      for (let h = 0; h < attentionHeads; h++) {
        const angle = (h / attentionHeads) * Math.PI * 2 + l * 0.15;
        const idx = (l * attentionHeads + h) * 2;
        dirs[idx] = Math.cos(angle);
        dirs[idx + 1] = Math.sin(angle);
      }
    }
    return dirs;
  }, [layerCount, attentionHeads]);

  // Fiber lines — LineSegments from ring to outer radius
  const fiberLinesRef = useRef<THREE.LineSegments>(null);
  const fiberGeo = useMemo(() => {
    const totalFibers = layerCount * attentionHeads;
    const verts = new Float32Array(totalFibers * 6);
    for (let l = 0; l < layerCount; l++) {
      const x = stackStart + l * layerSpacing;
      for (let h = 0; h < attentionHeads; h++) {
        const idx = l * attentionHeads + h;
        const dy = fiberDirs[idx * 2];
        const dz = fiberDirs[idx * 2 + 1];
        verts[idx * 6] = x;
        verts[idx * 6 + 1] = dy * ringRadius;
        verts[idx * 6 + 2] = dz * ringRadius;
        verts[idx * 6 + 3] = x;
        verts[idx * 6 + 4] = dy * fiberOuterRadius;
        verts[idx * 6 + 5] = dz * fiberOuterRadius;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    return geo;
  }, [layerCount, attentionHeads, stackStart, layerSpacing, ringRadius, fiberOuterRadius, fiberDirs]);

  const fiberMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: params.baseColor,
        transparent: true,
        opacity: 0.22,
        depthWrite: true,
        blending: THREE.NormalBlending,
      }),
    [params.baseColor]
  );

  // Head dots at mid-radius on each fiber
  const headDotCount = layerCount * attentionHeads;
  const dotMeshRef = useRef<THREE.InstancedMesh>(null);
  const dotDummy = useMemo(() => new THREE.Object3D(), []);

  const dotGeo = useMemo(() => new THREE.BoxGeometry(0.03, 0.015, 0.015), []);
  const dotMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: params.baseColor,
        emissive: params.baseColor,
        emissiveIntensity: 0.2,
        roughness: 0.4,
        metalness: 0.4,
      }),
    [params.baseColor]
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    // Fiber opacity
    const baseOpacity = 0.2;
    const thinkBoost = (phase === "think" || streaming) ? 0.1 : 0;
    fiberMat.opacity = baseOpacity + thinkBoost + instability * 0.08;

    // Head dots animation
    if (dotMeshRef.current) {
      for (let l = 0; l < layerCount; l++) {
        const x = stackStart + l * layerSpacing;
        for (let h = 0; h < attentionHeads; h++) {
          const idx = l * attentionHeads + h;
          const dy = fiberDirs[idx * 2];
          const dz = fiberDirs[idx * 2 + 1];
          const midR = ringRadius + (fiberOuterRadius - ringRadius) * 0.55;
          dotDummy.position.set(x, dy * midR, dz * midR);
          const baseAct = 0.4 + Math.abs(Math.sin(t * 2.0 + l * 0.8 + h * 0.6)) * 0.5;
          dotDummy.scale.setScalar(baseAct * 0.85 + 0.15);
          dotDummy.updateMatrix();
          dotMeshRef.current.setMatrixAt(idx, dotDummy.matrix);
        }
      }
      dotMeshRef.current.instanceMatrix.needsUpdate = true;
    }

    // Pulse dot material
    dotMat.emissiveIntensity = 0.2 + (streaming ? 0.15 : 0) + Math.sin(t * 2) * 0.05;
  });

  return (
    <group ref={groupRef}>
      <lineSegments ref={fiberLinesRef} geometry={fiberGeo} material={fiberMat} />
      <instancedMesh ref={dotMeshRef} args={[dotGeo, dotMat, headDotCount]} />
    </group>
  );
};

export default AttentionRings;
