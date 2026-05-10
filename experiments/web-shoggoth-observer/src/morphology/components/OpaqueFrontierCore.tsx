import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { createHologramMaterial, updateShaderTime } from "../../shaders/hologramMaterial";
import type { ResolvedVisualParams } from "../modelRegistry";

interface Props {
  params: ResolvedVisualParams;
  streaming: boolean;
  phase: string;
  instability: number;
  contextPressure: number;
}

/**
 * Sealed black-glass intelligence core for opaque frontier API models.
 * Nested reasoning shells, faint inner-layer hints, bright output aperture.
 * Does NOT display fake internal layers.
 *
 * Visual:
 *   - Dark translucent monolith/capsule at center
 *   - Faint stacked bands (approximate, marked simulated)
 *   - Nested rotating rings (reasoning shells)
 *   - Context rails external
 *   - Bright output aperture at bottom/front
 */
const OpaqueFrontierCore: React.FC<Props> = ({
  params,
  streaming,
  phase,
  instability,
  contextPressure,
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const shellRefs = useRef<THREE.Mesh[]>([]);

  const scale = params.scaleMultiplier;

  // Main sealed core — elongated capsule / rounded box
  const coreGeo = useMemo(
    () => new THREE.CapsuleGeometry(0.5 * scale, 4.5 * scale, 8, 24),
    [scale]
  );

  // Dark glass core material
  const coreMat = useMemo(
    () => createHologramMaterial(params.baseColor, params.accentColor, 0.12),
    [params.baseColor, params.accentColor]
  );

  // Inner layer hints — faint bands inside the core (simulated)
  const innerBandCount = 28;
  const innerBandMats = useMemo(
    () =>
      Array.from({ length: innerBandCount }, () =>
        new THREE.MeshBasicMaterial({
          color: params.baseColor,
          transparent: true,
          opacity: 0.04,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      ),
    [params.baseColor, innerBandCount]
  );

  // Nested reasoning shells — rotating rings
  const shellCount = 3;
  const shellData = useMemo(
    () =>
      Array.from({ length: shellCount }, (_, i) => {
        const r = 0.62 * scale + i * 0.06 * scale;
        const geo = new THREE.TorusGeometry(r, 0.003 * scale, 8, 64);
        const mat = new THREE.MeshBasicMaterial({
          color: params.accentColor,
          transparent: true,
          opacity: 0.15 + i * 0.05,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        return { geo, mat, tilt: Math.PI / 3 + i * 0.35, speed: 0.2 + i * 0.15 };
      }),
    [scale, params.accentColor]
  );

  // Output aperture glow
  const apertureMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: params.accentColor,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [params.accentColor]
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    // Update hologram shader
    updateShaderTime(coreMat, t, streaming ? 0.6 + instability * 0.3 : 0.15);

    // Reasoning shells rotate faster during think phase
    shellRefs.current.forEach((shell, i) => {
      if (!shell) return;
      const sd = shellData[i];
      const thinkBoost = phase === "think" || streaming ? 1.8 : 1;
      shell.rotation.z += 0.003 * sd.speed * thinkBoost * (1 + instability * 0.5);
      shell.rotation.x += 0.001 * sd.speed * thinkBoost;
      // Shell opacity pulses
      sd.mat.opacity = (0.15 + i * 0.05) + (streaming ? 0.08 : 0) + instability * 0.05;
    });

    // Breathing
    if (groupRef.current) {
      const breath = 1 + Math.sin(t * 0.35) * 0.008 + instability * 0.01;
      groupRef.current.scale.setScalar(breath);
    }

    // Update camera for fresnel
    coreMat.uniforms.uCameraPosition.value.copy(state.camera.position);
  });

  return (
    <group ref={groupRef} rotation={[0, 0, Math.PI / 2]}>
      {/* Main sealed core capsule */}
      <mesh geometry={coreGeo}>
        <primitive object={coreMat} attach="material" />
      </mesh>

      {/* Faint inner bands (simulated layer hints) */}
      {Array.from({ length: innerBandCount }, (_, i) => {
        const y = -2.2 * scale + (i / (innerBandCount - 1)) * 4.4 * scale;
        return (
          <mesh
            key={`iband-${i}`}
            position={[0, y, 0]}
            rotation={[0, Math.PI / 2, 0]}
          >
            <torusGeometry args={[0.42 * scale, 0.002 * scale, 8, 32]} />
            <primitive object={innerBandMats[i]} attach="material" />
          </mesh>
        );
      })}

      {/* Nested reasoning shells */}
      {shellData.map((sd, i) => (
        <mesh
          key={`shell-${i}`}
          ref={(el) => { shellRefs.current[i] = el!; }}
          geometry={sd.geo}
          material={sd.mat}
          rotation={[sd.tilt, 0, 0]}
        />
      ))}

      {/* Output aperture */}
      <mesh
        position={[2.35 * scale, 0, 0]}
      >
        <ringGeometry args={[0.3 * scale, 0.42 * scale, 32]} />
        <primitive object={apertureMat} attach="material" />
      </mesh>

      {/* Context pressure cage hint — faint red ring when pressure high */}
      {contextPressure > 0.75 && (
        <mesh>
          <torusGeometry
            args={[0.65 * scale, 0.005 * scale * contextPressure, 8, 48]}
          />
          <meshBasicMaterial
            color={contextPressure > 0.9 ? "#ff003c" : "#ef4444"}
            transparent
            opacity={contextPressure * 0.3}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}
    </group>
  );
};

export default OpaqueFrontierCore;
