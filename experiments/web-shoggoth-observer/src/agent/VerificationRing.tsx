import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntimeStore } from "../runtimeStore";
import { RUNTIME_COLORS } from "../eventTypes";

/**
 * Violet ring that clamps around the model during verification.
 * Passing tests release green pulse.
 * Failing tests create red fracture lines.
 */
const VerificationRing: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const verification = useRuntimeStore((s) => s.verification);

  const radius = 1.5;
  const ringGeo = useMemo(() => new THREE.TorusGeometry(radius, 0.015, 16, 80), [radius]);

  const ringMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: RUNTIME_COLORS.verification,
        emissive: RUNTIME_COLORS.verification,
        emissiveIntensity: 0.3,
        roughness: 0.3,
        metalness: 0.5,
        transparent: true,
        opacity: 0.0,
      }),
    []
  );

  // Fracture line segments for failed tests
  const fractureGeo = useMemo(() => {
    const segments = 12;
    const verts: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 0.3) / segments) * Math.PI * 2;
      verts.push(
        Math.cos(a1) * radius, 0, Math.sin(a1) * radius,
        Math.cos(a2) * radius, Math.sin(0.15) * radius, Math.sin(a2) * radius,
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
    return geo;
  }, [radius]);

  const fractureMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: RUNTIME_COLORS.suspicious,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    []
  );

  // Success pulse ring
  const successGeo = useMemo(() => new THREE.TorusGeometry(radius + 0.05, 0.02, 8, 48), [radius]);
  const successMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: RUNTIME_COLORS.success,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    []
  );

  const pulseRef = useRef(0);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    const isActive = verification.active;
    const isPass = verification.status === "pass";
    const isFail = verification.status === "fail";

    // Ring visibility
    const targetOpacity = isActive ? 0.7 : isPass || isFail ? 0.4 : 0;
    ringMat.opacity += (targetOpacity - ringMat.opacity) * 0.08;

    // Color shift
    if (isPass) {
      ringMat.color.set(RUNTIME_COLORS.success);
      ringMat.emissive.set(RUNTIME_COLORS.success);
    } else if (isFail) {
      ringMat.color.set(RUNTIME_COLORS.suspicious);
      ringMat.emissive.set(RUNTIME_COLORS.suspicious);
    } else {
      ringMat.color.set(RUNTIME_COLORS.verification);
      ringMat.emissive.set(RUNTIME_COLORS.verification);
    }

    ringMat.emissiveIntensity = 0.3 + (isActive ? 0.4 : 0);

    // Fracture visibility
    fractureMat.opacity += ((isFail ? 0.7 : 0) - fractureMat.opacity) * 0.1;

    // Success pulse
    if (isPass && pulseRef.current < 2) {
      pulseRef.current += 0.04;
      successMat.opacity = Math.max(0, 0.6 - pulseRef.current * 0.3);
    } else if (!isPass) {
      pulseRef.current = 0;
      successMat.opacity = 0;
    }

    // Rotation during verification
    if (groupRef.current && isActive) {
      groupRef.current.rotation.y += 0.02;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Main verification ring */}
      <mesh geometry={ringGeo} material={ringMat} rotation={[Math.PI / 2, 0, 0]} />

      {/* Fracture lines for failures */}
      <lineSegments geometry={fractureGeo} material={fractureMat} />

      {/* Success glow */}
      <mesh geometry={successGeo} material={successMat} rotation={[Math.PI / 2, 0, 0]} />
    </group>
  );
};

export default VerificationRing;
