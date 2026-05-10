import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { RUNTIME_COLORS } from "../../eventTypes";
import type { ResolvedVisualParams } from "../modelRegistry";

interface Props {
  params: ResolvedVisualParams;
  stackLength: number;
  streaming: boolean;
  instability: number;
  maxParticles?: number;
}

/**
 * Small white-blue packets flowing along the residual spine.
 * Each streamed token spawns a pulse that travels top-to-bottom.
 */
const TokenParticles: React.FC<Props> = ({
  params,
  stackLength,
  streaming,
  instability,
  maxParticles = 512,
}) => {
  const pointsRef = useRef<THREE.Points>(null);

  const particleCount = Math.min(maxParticles, 512);

  const particleData = useMemo(() => {
    const progress = new Float32Array(particleCount);
    const positions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      progress[i] = Math.random();
      positions[i * 3] = -stackLength / 2 + progress[i] * stackLength;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 0.1;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 0.1;
    }
    return { progress, positions };
  }, [particleCount, stackLength]);

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(particleData.positions, 3));
    return g;
  }, [particleData.positions]);

  const mat = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 0.05,
        color: RUNTIME_COLORS.tokenFlow,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    []
  );

  useFrame((_state, delta) => {
    if (!pointsRef.current) return;
    const posArr = geo.attributes.position.array as Float32Array;
    const speed =
      (streaming ? 0.15 : 0.04) * (1 + instability * 0.5);

    for (let i = 0; i < particleCount; i++) {
      let p = particleData.progress[i] + delta * speed * (0.6 + (i % 5) * 0.15);
      if (p > 1.0) p -= 1.0;
      particleData.progress[i] = p;
      const x = -stackLength / 2 + p * stackLength;
      posArr[i * 3] = x;
      posArr[i * 3 + 1] = (particleData.positions[i * 3 + 1] || 0) + Math.sin(p * 20) * 0.015;
      posArr[i * 3 + 2] = (particleData.positions[i * 3 + 2] || 0) + Math.cos(p * 17) * 0.015;
    }
    geo.attributes.position.needsUpdate = true;

    // Opacity follows streaming state
    mat.opacity += ((streaming ? 0.85 : 0.3) - mat.opacity) * 0.1;
  });

  return <points ref={pointsRef} geometry={geo} material={mat} />;
};

export default TokenParticles;
