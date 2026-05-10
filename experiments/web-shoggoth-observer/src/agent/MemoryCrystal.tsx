import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntimeStore } from "../runtimeStore";
import { RUNTIME_COLORS } from "../eventTypes";

/**
 * Green-black crystalline archive representing memory/FTS5 search.
 * Opens indexed shards when memory search is active.
 * Retrieved fragments flow back as green packets.
 */
const MemoryCrystal: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const memory = useRuntimeStore((s) => s.memory);

  const crystalPosition = useMemo(() => new THREE.Vector3(-2.8, 1.2, -1.5), []);

  // Core crystal geometry
  const coreGeo = useMemo(() => new THREE.OctahedronGeometry(0.35, 0), []);
  const coreMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: RUNTIME_COLORS.memory,
        emissive: RUNTIME_COLORS.memory,
        emissiveIntensity: 0.2,
        roughness: 0.3,
        metalness: 0.6,
        transparent: true,
        opacity: 0.7,
      }),
    []
  );

  // Shard plates that open during search
  const shardCount = 6;
  const shardRefs = useRef<THREE.Mesh[]>([]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (!groupRef.current) return;

    const isActive = memory.activeSearch;

    // Core pulsation
    coreMat.emissiveIntensity +=
      ((isActive ? 0.7 : 0.2) - coreMat.emissiveIntensity) * 0.08;
    groupRef.current.rotation.y += 0.005 + (isActive ? 0.02 : 0);

    // Shard plates spread when searching
    shardRefs.current.forEach((shard, i) => {
      if (!shard) return;
      const angle = (i / shardCount) * Math.PI * 2;
      const targetRadius = isActive ? 0.6 : 0.15;
      const currentRadius = shard.position.length();
      const newRadius = currentRadius + (targetRadius - currentRadius) * 0.06;
      shard.position.set(
        Math.cos(angle) * newRadius,
        (i % 3 - 1) * 0.2,
        Math.sin(angle) * newRadius
      );
      shard.rotation.set(t * 0.3 + i, t * 0.4 + i, 0);
    });
  });

  return (
    <group ref={groupRef} position={crystalPosition}>
      {/* Core crystal */}
      <mesh geometry={coreGeo} material={coreMat} />

      {/* Indexed shards */}
      {Array.from({ length: shardCount }, (_, i) => (
        <mesh
          key={`shard-${i}`}
          ref={(el) => { shardRefs.current[i] = el!; }}
          position={[0.1, (i % 3 - 1) * 0.1, 0.1]}
        >
          <boxGeometry args={[0.08, 0.15, 0.03]} />
          <meshStandardMaterial
            color={RUNTIME_COLORS.memory}
            emissive={RUNTIME_COLORS.memory}
            emissiveIntensity={0.3}
            roughness={0.4}
            metalness={0.5}
            transparent
            opacity={0.8}
          />
        </mesh>
      ))}

      {/* Search beam indicator */}
      {memory.activeSearch && (
        <mesh>
          <cylinderGeometry args={[0.01, 0.04, 2.5, 8]} />
          <meshBasicMaterial
            color={RUNTIME_COLORS.memory}
            transparent
            opacity={0.3}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}
    </group>
  );
};

export default MemoryCrystal;
