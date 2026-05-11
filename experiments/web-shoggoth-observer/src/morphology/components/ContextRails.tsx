import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { RUNTIME_COLORS } from "../../eventTypes";
import type { ResolvedVisualParams } from "../modelRegistry";

interface Props {
  params: ResolvedVisualParams;
  stackLength: number;
  contextPressure: number;
}

/**
 * Two vertical side rails showing context pressure.
 * Left and right of the transformer stack.
 * Color shifts: blue → amber → red with pressure.
 */
const ContextRails: React.FC<Props> = ({ params, stackLength, contextPressure }) => {
  const groupRef = useRef<THREE.Group>(null);
  const leftRef = useRef<THREE.Line>(null);
  const rightRef = useRef<THREE.Line>(null);

  const railOffsetX = 0.8 * params.scaleMultiplier;
  const halfLen = stackLength / 2;

  // Build rail geometries
  const railData = useMemo(() => {
    const verts = new Float32Array([
      -railOffsetX, -halfLen, 0,  -railOffsetX, halfLen, 0,
      railOffsetX, -halfLen, 0,   railOffsetX, halfLen, 0,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    const mat = new THREE.LineBasicMaterial({
      color: RUNTIME_COLORS.kvCache,
      transparent: true,
      opacity: 0.15,
      depthWrite: true,
    });
    return { geo, mat };
  }, [railOffsetX, halfLen]);

  // Ticks along rails
  const tickCount = 12;
  const tickData = useMemo(() => {
    const ticks: { y: number; mat: THREE.LineBasicMaterial }[] = [];
    for (let i = 0; i < tickCount; i++) {
      const y = -halfLen + (i / (tickCount - 1)) * stackLength;
      ticks.push({
        y,
        mat: new THREE.LineBasicMaterial({
          color: RUNTIME_COLORS.kvCache,
          transparent: true,
          opacity: 0.08,
          depthWrite: true,
        }),
      });
    }
    return ticks;
  }, [tickCount, halfLen, stackLength]);

  const tickGeo = useMemo(
    () => new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.08, 0, 0),
      new THREE.Vector3(0.08, 0, 0),
    ]),
    []
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    // Rail color based on pressure
    const pressure = contextPressure;
    let railColor: string;
    let railOpacity: number;
    if (pressure > 0.9) { railColor = RUNTIME_COLORS.suspicious; railOpacity = 0.35; }
    else if (pressure > 0.75) { railColor = RUNTIME_COLORS.shellCommand; railOpacity = 0.25; }
    else if (pressure > 0.5) { railColor = "#f59e0b"; railOpacity = 0.18; }
    else { railColor = RUNTIME_COLORS.kvCache; railOpacity = 0.12; }

    railData.mat.color.set(railColor);
    railData.mat.opacity = railOpacity;

    // Rotate slowly
    if (groupRef.current) {
      groupRef.current.rotation.y += 0.001;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Vertical side rails */}
      <lineSegments geometry={railData.geo} material={railData.mat} />

      {/* Tick marks */}
      {tickData.map((tick, i) => (
        <lineSegments
          key={`tick-${i}`}
          geometry={tickGeo}
          material={tick.mat}
          position={[-railOffsetX, tick.y, 0]}
        />
      ))}
      {tickData.map((tick, i) => (
        <lineSegments
          key={`tick-r-${i}`}
          geometry={tickGeo}
          material={tick.mat}
          position={[railOffsetX, tick.y, 0]}
        />
      ))}
    </group>
  );
};

export default ContextRails;
