import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntimeStore } from "../runtimeStore";
import { RUNTIME_COLORS } from "../eventTypes";

/**
 * Red containment cage that appears around the morphology when
 * a high-risk shell command is about to be executed.
 *
 * Creates cage geometry once, toggles visibility. No per-frame destruction.
 */
const SuspicionCage: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const shell = useRuntimeStore((s) => s.shell);
  const isHighRisk = shell.risk === "high";

  const barCount = 16;
  const radius = 1.2;
  const height = 8.5;

  // Precompute bar positions
  const barData = useMemo(() =>
    Array.from({ length: barCount }, (_, i) => {
      const angle = (i / barCount) * Math.PI * 2;
      return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
    }),
  []);

  const barGeo = useMemo(() => new THREE.CylinderGeometry(0.008, 0.008, height, 4), []);
  const ringGeo = useMemo(() => new THREE.TorusGeometry(radius, 0.01, 8, 32), []);

  // Persistent materials (updated in useFrame, not recreated)
  const barMatsRef = useRef<THREE.MeshBasicMaterial[]>([]);
  const ringMatsRef = useRef<THREE.MeshBasicMaterial[]>([]);
  const barsRef = useRef<THREE.Mesh[]>([]);
  const ringsRef = useRef<THREE.Mesh[]>([]);
  const initialized = useRef(false);

  // Create cage meshes once on first render when group is available
  const initCage = (grp: THREE.Group) => {
    if (initialized.current) return;
    initialized.current = true;

    barData.forEach(({ x, z }) => {
      const mat = new THREE.MeshBasicMaterial({
        color: RUNTIME_COLORS.suspicious,
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const bar = new THREE.Mesh(barGeo, mat);
      bar.position.set(x, 0, z);
      bar.visible = false;
      grp.add(bar);
      barMatsRef.current.push(mat);
      barsRef.current.push(bar);
    });

    for (const y of [-height / 2, height / 2]) {
      const mat = new THREE.MeshBasicMaterial({
        color: RUNTIME_COLORS.suspicious,
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.position.set(0, y, 0);
      ring.visible = false;
      grp.add(ring);
      ringMatsRef.current.push(mat);
      ringsRef.current.push(ring);
    }
  };

  useFrame((state) => {
    const grp = groupRef.current;
    if (!grp) return;
    initCage(grp);

    const t = state.clock.elapsedTime;
    const opacity = 0.3 + Math.sin(t * 6) * 0.15;
    const visible = isHighRisk;

    barsRef.current.forEach((bar) => { bar.visible = visible; });
    ringsRef.current.forEach((ring) => { ring.visible = visible; });

    barMatsRef.current.forEach((mat) => { mat.opacity = opacity; });
    ringMatsRef.current.forEach((mat) => { mat.opacity = opacity * 1.3; });

    if (visible) {
      grp.rotation.y += 0.01;
      grp.scale.setScalar(1 + Math.sin(t * 5) * 0.03);
    }
  });

  return <group ref={groupRef} />;
};

export default SuspicionCage;
