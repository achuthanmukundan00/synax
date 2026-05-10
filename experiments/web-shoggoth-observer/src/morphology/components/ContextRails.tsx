import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { RUNTIME_COLORS } from "../../eventTypes";
import type { ResolvedVisualParams } from "../modelRegistry";

interface Props {
  params: ResolvedVisualParams;
  stackLength: number;
  contextPressure: number;
  knownTokens?: number;
  maxTokens?: number;
}

/**
 * External rails showing prompt/context growth.
 * Always present if context telemetry is available.
 *
 * Visual mapping:
 *   0.00–0.50: calm blue-gray rails
 *   0.50–0.75: rails thicken
 *   0.75–0.90: amber outer pressure ring
 *   0.90–1.00: red compression signal
 */
const ContextRails: React.FC<Props> = ({ params, stackLength, contextPressure }) => {
  const groupRef = useRef<THREE.Group>(null);
  const railRefs = useRef<THREE.LineSegments[]>([]);

  const railCount = 4;
  const railRadius = 1.4 * params.scaleMultiplier;

  // Color shifts with pressure
  const getRailColor = (pressure: number): string => {
    if (pressure > 0.9) return RUNTIME_COLORS.suspicious;
    if (pressure > 0.75) return RUNTIME_COLORS.shellCommand;
    return RUNTIME_COLORS.kvCache;
  };

  const getRailOpacity = (pressure: number): number => {
    if (pressure > 0.75) return 0.25 + (pressure - 0.75) * 2;
    return 0.12 + pressure * 0.15;
  };

  // Build rail geometries — vertical lines around the core
  const railData = useMemo(() => {
    return Array.from({ length: railCount }, (_, i) => {
      const angle = (i / railCount) * Math.PI * 2;
      const x = Math.cos(angle) * railRadius;
      const z = Math.sin(angle) * railRadius;
      const yStart = -stackLength / 2;
      const yEnd = stackLength / 2;

      const verts = new Float32Array([x, yStart, z, x, yEnd, z]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
      const mat = new THREE.LineBasicMaterial({
        color: getRailColor(contextPressure),
        transparent: true,
        opacity: getRailOpacity(contextPressure),
        depthWrite: true,
        blending: contextPressure > 0.75 ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      return { geo, mat, angle };
    });
  }, [railRadius, stackLength, contextPressure]);

  // Pressure rings
  const pressureRings = useMemo(() => {
    if (contextPressure <= 0.5) return null;
    const ringCount = contextPressure > 0.85 ? 3 : contextPressure > 0.65 ? 2 : 1;
    return Array.from({ length: ringCount }, (_, i) => {
      const y = -stackLength * 0.4 + i * (stackLength * 0.8) / (ringCount - 1 || 1);
      const geo = new THREE.TorusGeometry(railRadius + 0.05, 0.003 + contextPressure * 0.01, 8, 64);
      const color = contextPressure > 0.85 ? RUNTIME_COLORS.suspicious : RUNTIME_COLORS.shellCommand;
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: contextPressure * 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      return { geo, mat, y };
    });
  }, [contextPressure, railRadius, stackLength]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    // Update rail colors/opacity reactively
    const color = getRailColor(contextPressure);
    const opacity = getRailOpacity(contextPressure);
    railRefs.current.forEach((rail) => {
      if (rail && rail.material instanceof THREE.LineBasicMaterial) {
        rail.material.color.set(color);
        rail.material.opacity = opacity;
      }
    });

    // Rotate rails slowly
    if (groupRef.current) {
      groupRef.current.rotation.y += 0.002;
      // Speed up with pressure
      if (contextPressure > 0.75) {
        groupRef.current.rotation.y += contextPressure * 0.005;
      }
    }
  });

  return (
    <group ref={groupRef}>
      {railData.map((data, i) => (
        <lineSegments
          key={`rail-${i}`}
          ref={(el) => { railRefs.current[i] = el!; }}
          geometry={data.geo}
          material={data.mat}
        />
      ))}
      {pressureRings?.map((ring, i) => (
        <mesh key={`pring-${i}`} geometry={ring.geo} material={ring.mat} position={[0, ring.y, 0]} />
      ))}
    </group>
  );
};

export default ContextRails;
