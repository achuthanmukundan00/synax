import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntimeStore } from "../runtimeStore";
import { RUNTIME_COLORS } from "../eventTypes";

/**
 * Red containment cage that appears around the morphology when
 * a high-risk shell command is about to be executed.
 *
 * Visual: jagged red beam cage, scanlines, command preview.
 * The cage communicates: "the model is about to do something consequential."
 */
const SuspicionCage: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const shell = useRuntimeStore((s) => s.shell);
  const instability = useRuntimeStore((s) => s.instability);

  const isHighRisk = shell.risk === "high";

  // Cage geometry — vertical bars forming a cylinder
  const barCount = 16;
  const radius = 1.2;
  const height = 8.5;

  const barData = useMemo(() => {
    return Array.from({ length: barCount }, (_, i) => {
      const angle = (i / barCount) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      return { x, z, angle };
    });
  }, [barCount, radius]);

  const cageRefs = useRef<THREE.Mesh[]>([]);

  const barGeo = useMemo(
    () => new THREE.CylinderGeometry(0.008, 0.008, height, 4),
    [height]
  );

  useFrame((state) => {
    if (!groupRef.current) return;
    const t = state.clock.elapsedTime;

    // Clear and rebuild cage bars (only when high risk)
    const grp = groupRef.current;
    while (grp.children.length > 0) {
      const child = grp.children[0];
      if (child instanceof THREE.Mesh && child.material instanceof THREE.Material) {
        child.material.dispose();
      }
      grp.remove(child);
    }

    if (!isHighRisk) return;

    const opacity = 0.3 + Math.sin(t * 6) * 0.15;

    // Red bars
    barData.forEach(({ x, z }) => {
      const mat = new THREE.MeshBasicMaterial({
        color: RUNTIME_COLORS.suspicious,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const bar = new THREE.Mesh(barGeo, mat);
      bar.position.set(x, 0, z);
      grp.add(bar);
    });

    // Top and bottom rings
    for (const y of [-height / 2, height / 2]) {
      const ringGeoTop = new THREE.TorusGeometry(radius, 0.01, 8, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: RUNTIME_COLORS.suspicious,
        transparent: true,
        opacity: opacity * 1.3,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(ringGeoTop, ringMat);
      ring.position.set(0, y, 0);
      grp.add(ring);
    }

    // Pulse rotation
    grp.rotation.y += 0.01;
    const scalePulse = 1 + Math.sin(t * 5) * 0.03;
    grp.scale.setScalar(scalePulse);
  });

  return <group ref={groupRef} />;
};

export default SuspicionCage;
