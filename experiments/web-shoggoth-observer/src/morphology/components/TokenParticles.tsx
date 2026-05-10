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

const MAX_PARTICLES = 600;
const MAX_PARTICLE_AGE = 3.5; // seconds
const MAX_PARTICLE_DISTANCE = 12;
const SCENE_BOUNDS = 30;
const MAX_SPEED = 3.0;

function randBetween(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

interface ParticleState {
  age: number;
  maxAge: number;
  originY: number;
}

/**
 * Bounded token particles flowing along the residual spine.
 * Each particle has age, maxAge, origin, and bounded velocity.
 * Dead particles are recycled to origin with fresh parameters.
 */
const TokenParticles: React.FC<Props> = ({
  params,
  stackLength,
  streaming,
  instability,
  maxParticles = 200,
}) => {
  const pointsRef = useRef<THREE.Points>(null);

  const particleCount = Math.min(maxParticles, MAX_PARTICLES);

  // Particle state: age, maxAge, origin
  const particleStates = useMemo((): ParticleState[] => {
    const states: ParticleState[] = [];
    for (let i = 0; i < particleCount; i++) {
      states.push({
        age: randBetween(0, MAX_PARTICLE_AGE),
        maxAge: randBetween(1.5, MAX_PARTICLE_AGE),
        originY: -stackLength / 2 + Math.random() * stackLength,
      });
    }
    return states;
  }, [particleCount, stackLength]);

  // Position buffer
  const positions = useMemo(() => {
    const arr = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 0.1;
      arr[i * 3 + 1] = particleStates[i].originY;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 0.1;
    }
    return arr;
  }, [particleCount, particleStates]);

  // Per-particle velocity buffer (stored outside geometry, in a ref)
  const velocities = useMemo(() => {
    const arr = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      // Normalized direction with bounded speed
      const vx = randBetween(-1, 1);
      const vy = randBetween(-0.15, 1.0); // mostly downward
      const vz = randBetween(-1, 1);
      const len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      const speed = randBetween(0.2, MAX_SPEED);
      arr[i * 3] = (vx / len) * speed * 0.3;
      arr[i * 3 + 1] = (vy / len) * speed;
      arr[i * 3 + 2] = (vz / len) * speed * 0.3;
    }
    return arr;
  }, [particleCount]);

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [positions]);

  const mat = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 0.04,
        color: RUNTIME_COLORS.tokenFlow,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    []
  );

  function recycleParticle(i: number): void {
    const s = particleStates[i];
    s.age = 0;
    s.maxAge = randBetween(1.5, MAX_PARTICLE_AGE);
    s.originY = -stackLength / 2 + Math.random() * stackLength;
    positions[i * 3] = (Math.random() - 0.5) * 0.1;
    positions[i * 3 + 1] = s.originY;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 0.1;
  }

  useFrame((_state, rawDelta) => {
    if (!pointsRef.current) return;

    // Clamp delta time to prevent physics explosion after tab switch
    const dt = Math.min(rawDelta, 1 / 20);
    const speedMult = (streaming ? 1.6 : 0.35) * (1 + instability * 0.5);

    for (let i = 0; i < particleCount; i++) {
      const state = particleStates[i];
      state.age += dt;

      // Move particle
      const idx = i * 3;
      positions[idx] += velocities[idx] * dt * speedMult;
      positions[idx + 1] += velocities[idx + 1] * dt * speedMult;
      positions[idx + 2] += velocities[idx + 2] * dt * speedMult;

      const px = positions[idx];
      const py = positions[idx + 1];
      const pz = positions[idx + 2];

      // Kill conditions
      const distFromOrigin = Math.abs(py - state.originY);
      const fromCenter = Math.sqrt(py * py + pz * pz);

      if (
        state.age > state.maxAge ||
        distFromOrigin > MAX_PARTICLE_DISTANCE ||
        fromCenter > MAX_PARTICLE_DISTANCE ||
        Math.abs(px) > SCENE_BOUNDS ||
        Math.abs(py) > SCENE_BOUNDS ||
        Math.abs(pz) > SCENE_BOUNDS
      ) {
        recycleParticle(i);
      }
    }

    geo.attributes.position.needsUpdate = true;

    // Opacity follows streaming state
    mat.opacity += ((streaming ? 0.75 : 0.25) - mat.opacity) * 0.1;
  });

  return <points ref={pointsRef} geometry={geo} material={mat} />;
};

export default TokenParticles;
