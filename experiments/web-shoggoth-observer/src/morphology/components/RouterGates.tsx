import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ResolvedVisualParams } from "../modelRegistry";

interface Props {
  params: ResolvedVisualParams;
  streaming: boolean;
  phase: string;
  instability: number;
}

/**
 * Gates between attention and expert phase in MoE models.
 * Animated beam origin points. Flash on token routing.
 */
const RouterGates: React.FC<Props> = ({ params, streaming, phase, instability }) => {
  const groupRef = useRef<THREE.Group>(null);
  const gateCount = 8;
  const radius = 0.85 * params.scaleMultiplier;

  const gateGeo = useMemo(
    () => new THREE.OctahedronGeometry(0.04, 0),
    []
  );

  const gatePositions = useMemo(() => {
    return Array.from({ length: gateCount }, (_, i) => {
      const angle = (i / gateCount) * Math.PI * 2;
      return {
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        y: ((i % 3) - 1) * 0.8,
      };
    });
  }, [radius, gateCount]);

  const gateMats = useMemo(
    () =>
      gatePositions.map(
        () =>
          new THREE.MeshStandardMaterial({
            color: params.accentColor,
            emissive: params.accentColor,
            emissiveIntensity: 0.3,
            roughness: 0.2,
            metalness: 0.7,
          })
      ),
    [params.accentColor, gatePositions]
  );

  const gateRefs = useRef<THREE.Mesh[]>([]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    gateRefs.current.forEach((gate, i) => {
      if (!gate) return;
      const mat = gateMats[i];
      if (!mat) return;

      // Random router flash when streaming
      const flash = streaming && Math.sin(t * 15 + i * 2.7) > 0.85 ? 1.5 : 1;
      mat.emissiveIntensity = 0.3 * flash + instability * 0.3;

      // Subtle rotation
      gate.rotation.y += 0.02;
      gate.rotation.x += 0.01;
    });
  });

  return (
    <group ref={groupRef}>
      {gatePositions.map((pos, i) => (
        <mesh
          key={`gate-${i}`}
          ref={(el) => { gateRefs.current[i] = el!; }}
          geometry={gateGeo}
          material={gateMats[i]}
          position={[pos.x, pos.y, pos.z]}
        />
      ))}
    </group>
  );
};

export default RouterGates;
