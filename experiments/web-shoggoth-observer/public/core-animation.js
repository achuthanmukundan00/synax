/**
 * Animation Loop — Phase reactivity, activation cascades, zoom LOD.
 *
 * Exports:
 *   startAnimationLoop(refs, profile, composer, bloomPass, controls, camera, renderer)
 *   setPhase(phase)
 *   setSeverity(level)
 *   setModelId(id)
 */

import * as THREE from 'three';
import { ROLE_PALETTES, resolveProfile } from './core-profiles.js';

// ─── Mutable animation state (shared with SSE handler via exports) ──────

let currentPhase = 'idle';
let targetSeverityPulse = 0;
let severityPulse = 0;
let shakeIntensity = 0;
const shakeOffset = new THREE.Vector3();
let currentProfile = null;

// Cascade wave: a pulse of activation that sweeps through layers
let cascadeActive = false;
let cascadeStartTime = 0;
const CASCADE_DURATION = 1.8; // seconds for wave to travel all layers
const CASCADE_COOLDOWN = 0.6;

// LOD: camera distance threshold for neuron cluster visibility
const NEURON_VISIBLE_DIST = 4.5;
const NEURON_FULL_DIST = 2.2;

// Target colors (lerped toward in animation)
const targetColors = {
  spine: new THREE.Color('#5080a8'),
  ring: new THREE.Color('#2a4a68'),
  fiber: new THREE.Color('#1e3850'),
  mlp: new THREE.Color('#182838'),
  kv: new THREE.Color('#101828'),
  pulse: new THREE.Color('#80c0e0'),
};

// ─── Color helpers ──────────────────────────────────────────────────────

function hexToColor(hex) {
  return new THREE.Color(hex);
}

function getBasePalette() {
  if (!currentProfile || !currentProfile.colorRole) return ROLE_PALETTES.neutral;
  return ROLE_PALETTES[currentProfile.colorRole] || ROLE_PALETTES.neutral;
}

// ─── Public state setters ────────────────────────────────────────────────

export function setPhase(phase) {
  if (phase !== currentPhase) {
    currentPhase = phase;
    // Trigger a cascade wave on thinking/streaming
    if (phase === 'thinking' || phase === 'streaming') {
      cascadeActive = true;
      cascadeStartTime = performance.now() / 1000;
    }
  }
}

export function setSeverity(level) {
  targetSeverityPulse = level;
}

export function setModelId(modelId) {
  const profile = resolveProfile(modelId);
  currentProfile = profile;
  // Rebuild would be needed for full profile change — for now, just color role
}

export function getCurrentPhase() {
  return currentPhase;
}

// ─── Main animation loop ─────────────────────────────────────────────────

let clock = null;

export function startAnimationLoop(refs, profile, composer, bloomPass, controls, camera) {
  currentProfile = profile;
  clock = new THREE.Clock();

  const basePal = getBasePalette();
  // Init target colors from base palette (idle phase)
  targetColors.spine.set(basePal.spine);
  targetColors.ring.set(basePal.ring);
  targetColors.fiber.set(basePal.fiber);
  targetColors.mlp.set(basePal.mlp);
  targetColors.kv.set(basePal.kv);
  targetColors.pulse.set(basePal.pulse);

  // Error override colors
  const ERR_SPINE = hexToColor('#601818');
  const ERR_RING   = hexToColor('#402020');
  const ERR_FIBER  = hexToColor('#281010');
  const ERR_MLP    = hexToColor('#200808');
  const ERR_KV     = hexToColor('#100808');
  const ERR_PULSE  = hexToColor('#802020');

  // Thinking boost colors (brighter than base)
  const THINK_SPINE = new THREE.Color();
  const THINK_RING  = new THREE.Color();
  const THINK_FIBER = new THREE.Color();
  const THINK_MLP   = new THREE.Color();
  const THINK_KV    = new THREE.Color();
  const THINK_PULSE = new THREE.Color();

  // Streaming green colors
  const STREAM_SPINE = hexToColor('#489860');
  const STREAM_RING  = hexToColor('#285838');
  const STREAM_FIBER = hexToColor('#1c4028');
  const STREAM_MLP   = hexToColor('#142818');
  const STREAM_KV    = hexToColor('#0c1810');
  const STREAM_PULSE = hexToColor('#70c880');

  // Tool colors (amber)
  const TOOL_SPINE = hexToColor('#986830');
  const TOOL_RING  = hexToColor('#584020');
  const TOOL_FIBER = hexToColor('#402818');
  const TOOL_MLP   = hexToColor('#281810');
  const TOOL_KV    = hexToColor('#181008');
  const TOOL_PULSE = hexToColor('#c09040');

  // Completed colors (green calm)
  const DONE_SPINE = hexToColor('#489060');
  const DONE_RING  = hexToColor('#285028');
  const DONE_FIBER = hexToColor('#1c381c');
  const DONE_MLP   = hexToColor('#142014');
  const DONE_KV    = hexToColor('#0c100c');
  const DONE_PULSE = hexToColor('#70b870');

  function computePhaseTargets() {
    const b = basePal;
    // Start from base, brighten for thinking
    THINK_SPINE.set(b.spine).multiplyScalar(1.25);
    THINK_RING.set(b.ring).multiplyScalar(1.2);
    THINK_FIBER.set(b.fiber).multiplyScalar(1.15);
    THINK_MLP.set(b.mlp).multiplyScalar(1.1);
    THINK_KV.set(b.kv).multiplyScalar(1.1);
    THINK_PULSE.set(b.pulse).multiplyScalar(1.3);
  }
  computePhaseTargets();

  function getPhaseTargets(phase) {
    switch (phase) {
      case 'thinking':     return [THINK_SPINE, THINK_RING, THINK_FIBER, THINK_MLP, THINK_KV, THINK_PULSE];
      case 'streaming':    return [STREAM_SPINE, STREAM_RING, STREAM_FIBER, STREAM_MLP, STREAM_KV, STREAM_PULSE];
      case 'tool_running': return [TOOL_SPINE, TOOL_RING, TOOL_FIBER, TOOL_MLP, TOOL_KV, TOOL_PULSE];
      case 'tool_pending': return [TOOL_SPINE, TOOL_RING, TOOL_FIBER, TOOL_MLP, TOOL_KV, TOOL_PULSE];
      case 'error':        return [ERR_SPINE, ERR_RING, ERR_FIBER, ERR_MLP, ERR_KV, ERR_PULSE];
      case 'completed':    return [DONE_SPINE, DONE_RING, DONE_FIBER, DONE_MLP, DONE_KV, DONE_PULSE];
      case 'blocked':      return [TOOL_SPINE, TOOL_RING, TOOL_FIBER, TOOL_MLP, TOOL_KV, TOOL_PULSE];
      default: {
        const b = basePal;
        return [hexToColor(b.spine), hexToColor(b.ring), hexToColor(b.fiber),
                hexToColor(b.mlp), hexToColor(b.kv), hexToColor(b.pulse)];
      }
    }
  }

  function animate() {
    requestAnimationFrame(animate);

    const t = clock.getElapsedTime();
    const dt = Math.min(clock.getDelta(), 0.1);

    controls.update();

    // ── Severity smoothing ──
    severityPulse += (targetSeverityPulse - severityPulse) * 0.06;

    // ── Phase color targets ──
    const [tSpine, tRing, tFiber, tMlp, tKv, tPulse] = getPhaseTargets(currentPhase);

    // Blend with error colors if severity is high
    const sev = severityPulse;
    if (sev > 0.25) {
      const f = Math.min((sev - 0.25) / 0.55, 1.0);
      targetColors.spine.copy(tSpine).lerp(ERR_SPINE, f);
      targetColors.ring.copy(tRing).lerp(ERR_RING, f);
      targetColors.fiber.copy(tFiber).lerp(ERR_FIBER, f);
      targetColors.mlp.copy(tMlp).lerp(ERR_MLP, f);
      targetColors.kv.copy(tKv).lerp(ERR_KV, f);
      targetColors.pulse.copy(tPulse).lerp(ERR_PULSE, f);
    } else {
      targetColors.spine.copy(tSpine);
      targetColors.ring.copy(tRing);
      targetColors.fiber.copy(tFiber);
      targetColors.mlp.copy(tMlp);
      targetColors.kv.copy(tKv);
      targetColors.pulse.copy(tPulse);
    }

    // ── Error shake ──
    const targetShake = (currentPhase === 'error' || sev > 0.5) ? sev : 0;
    shakeIntensity += (targetShake - shakeIntensity) * 0.12;
    if (shakeIntensity > 0.001) {
      const s = shakeIntensity * 0.06;
      shakeOffset.set(
        Math.sin(t * 22) * s + Math.cos(t * 35 + 1.3) * s * 0.5,
        Math.cos(t * 25 + 2.1) * s + Math.sin(t * 40 + 0.7) * s * 0.4,
        Math.sin(t * 28 + 1.8) * s * 0.3,
      );
      refs.coreGroup.position.copy(shakeOffset);
    } else {
      refs.coreGroup.position.set(0, 0, 0);
    }

    // ── Slow orbital drift ──
    refs.coreGroup.rotation.y += dt * 0.04;
    refs.coreGroup.rotation.x += dt * 0.01;

    // ── Breathing ──
    const breath = 1 + Math.sin(t * currentProfile.breathRate) * 0.006 + shakeIntensity * 0.015;
    refs.coreGroup.scale.setScalar(breath);

    // ── Cascade wave ──
    let cascadeProgress = 0;
    if (cascadeActive) {
      const elapsed = t - cascadeStartTime;
      if (elapsed > CASCADE_DURATION + CASCADE_COOLDOWN) {
        cascadeActive = false;
        cascadeProgress = 1.0;
      } else if (elapsed < 0) {
        cascadeProgress = 0;
      } else {
        cascadeProgress = Math.min(elapsed / CASCADE_DURATION, 1.0);
      }
    }

    // ── Spine emissive ──
    if (refs.spineMat) {
      refs.spineMat.emissive.lerp(targetColors.spine, 0.06);
      refs.spineMat.emissiveIntensity = 0.8 + Math.sin(t * 0.8) * 0.15 + sev * 0.5;
    }
    if (refs.spine) {
      refs.spine.scale.set(1, 1 + Math.sin(t * 1.5) * 0.03, 1 + Math.sin(t * 1.5) * 0.03);
    }

    // ── Layer rings — wobble + cascade ──
    if (refs.ringMesh) {
      const L = refs.ringCount;
      const d = refs.ringDummy;
      for (let l = 0; l < L; l++) {
        const x = refs.STACK_START + l * refs.LAYER_SPACING;
        const wobble = 1 + Math.sin(t * 1.3 + l * 0.4) * 0.02;
        // Cascade: layers near the wave front expand
        const layerNorm = l / (L - 1);
        const distToWave = cascadeActive ? Math.abs(layerNorm - cascadeProgress) : 1;
        const cascadeBoost = cascadeActive ? Math.max(0, 1 - distToWave * 4) * 0.08 : 0;
        d.position.set(x, 0, 0);
        d.rotation.set(0, Math.PI / 2 + Math.sin(t * 0.7 + l * 0.2) * 0.03, 0);
        d.scale.setScalar(wobble + cascadeBoost);
        d.updateMatrix();
        refs.ringMesh.setMatrixAt(l, d.matrix);
      }
      refs.ringMesh.instanceMatrix.needsUpdate = true;
      refs.ringMat.emissive.lerp(targetColors.ring, 0.05);
      refs.ringMat.color.lerp(targetColors.ring, 0.04);
    }

    // ── Attention fibers color ──
    if (refs.fiberMat) {
      refs.fiberMat.color.lerp(targetColors.fiber, 0.05);
    }

    // ── MLP slabs — pulse + cascade ──
    if (refs.mlpMesh) {
      const L = refs.ringCount;
      const d = refs.ringDummy;
      for (let l = 0; l < L; l++) {
        const x = refs.STACK_START + l * refs.LAYER_SPACING;
        const pulse = 1 + Math.sin(t * 1.1 + l * 0.3) * 0.04;
        d.position.set(x, 0, refs.MLP_OFFSET_Z);
        d.scale.set(1, pulse, 1);
        d.rotation.set(0, 0, Math.sin(t * 0.5 + l * 0.1) * 0.02);
        d.updateMatrix();
        refs.mlpMesh.setMatrixAt(l, d.matrix);
      }
      refs.mlpMesh.instanceMatrix.needsUpdate = true;
      refs.mlpMat.emissive.lerp(targetColors.mlp, 0.05);
    }

    // ── Head dots — activation + cascade wave ──
    if (refs.headDotMesh) {
      const L = refs.L, H = refs.H;
      const d = refs.ringDummy;
      const dirs = refs.fiberDirs;
      for (let l = 0; l < L; l++) {
        const x = refs.STACK_START + l * refs.LAYER_SPACING;
        const layerNorm = l / (L - 1);
        const distToWave = cascadeActive ? Math.abs(layerNorm - cascadeProgress) : 1;
        const cascadeActivation = cascadeActive ? Math.max(0, 1 - distToWave * 3) : 0;

        for (let h = 0; h < H; h++) {
          const idx = l * H + h;
          const dy = dirs[idx * 2], dz = dirs[idx * 2 + 1];
          const midR = refs.RING_RADIUS + (refs.FIBER_OUTER_RADIUS - refs.RING_RADIUS)
            * (0.5 + Math.sin(t * 2.5 + l * 0.5 + h * 0.7) * 0.1);
          d.position.set(x, dy * midR, dz * midR);
          // Base activity + cascade boost
          const baseAct = 0.4 + Math.abs(Math.sin(t * 2.0 + l * 0.8 + h * 0.6)) * 0.5;
          const act = Math.min(1, baseAct + cascadeActivation * 0.6);
          d.scale.setScalar(act * 0.85 + 0.15);
          d.updateMatrix();
          refs.headDotMesh.setMatrixAt(idx, d.matrix);
        }
      }
      refs.headDotMesh.instanceMatrix.needsUpdate = true;
      refs.headDotMat.emissive.lerp(targetColors.fiber, 0.05);
    }

    // ── Neuron clusters — zoom LOD ──
    if (refs.neuronMesh) {
      const camDist = camera.position.distanceTo(controls.target);
      let neuronOpacity = 0;
      if (camDist < NEURON_VISIBLE_DIST) {
        neuronOpacity = Math.max(0, Math.min(1,
          (NEURON_VISIBLE_DIST - camDist) / (NEURON_VISIBLE_DIST - NEURON_FULL_DIST)
        ));
      }
      refs.neuronMat.opacity = neuronOpacity * 0.5;
      refs.neuronMat.color.lerp(targetColors.fiber, 0.05);

      // Animate neuron positions subtly when visible
      if (neuronOpacity > 0.01) {
        const L = refs.L, H = refs.H;
        const dirs = refs.fiberDirs;
        const d = refs.ringDummy;
        const N = refs.NEURONS_PER_HEAD;
        for (let l = 0; l < L; l++) {
          const x = refs.STACK_START + l * refs.LAYER_SPACING;
          for (let h = 0; h < H; h++) {
            const headIdx = l * H + h;
            const dy = dirs[headIdx * 2], dz = dirs[headIdx * 2 + 1];
            const midR = refs.RING_RADIUS + (refs.FIBER_OUTER_RADIUS - refs.RING_RADIUS) * 0.55;
            const cx = x, cy = dy * midR, cz = dz * midR;
            for (let n = 0; n < N; n++) {
              const ni = headIdx * N + n;
              const angle = (n / N) * Math.PI * 2 + t * 0.8;
              const r = 0.025;
              d.position.set(
                cx + Math.cos(angle) * r,
                cy + Math.sin(angle) * r * 0.5,
                cz + Math.sin(t * 3 + n) * 0.008,
              );
              d.scale.setScalar(0.5 + Math.abs(Math.sin(t * 2 + headIdx * 0.1 + n)) * 0.5);
              d.updateMatrix();
              refs.neuronMesh.setMatrixAt(ni, d.matrix);
            }
          }
        }
        refs.neuronMesh.instanceMatrix.needsUpdate = true;
      }
    }

    // ── KV cache ──
    if (refs.kvMat) {
      refs.kvMat.color.lerp(targetColors.kv, 0.05);
      refs.kvMat.opacity = 0.12 + sev * 0.05;
    }

    // ── Output surface ──
    if (refs.outputSurface) {
      refs.outputSurface.scale.setScalar(1 + Math.sin(t * 1.0) * 0.04);
      refs.outputMat.emissive.lerp(targetColors.spine, 0.05);
    }

    // ── Token pulses ──
    if (refs.tokenPoints) {
      const posArr = refs.tokenGeo.attributes.position.array;
      const prog = refs.tokenProgress;
      const speed = currentProfile.cascadeSpeed
        * (currentPhase === 'error' ? 2.5 : currentPhase === 'thinking' ? 1.6 : 1.0);
      const TC = refs.tokenCount;
      for (let i = 0; i < TC; i++) {
        let p = prog[i] + dt * (0.08 + (i % 5) * 0.04) * speed;
        if (p > 1.0) p -= 1.0;
        prog[i] = p;
        const x = refs.STACK_START + p * (refs.STACK_END - refs.STACK_START);
        posArr[i * 3] = x;
        posArr[i * 3 + 1] = Math.sin(t * 4 + i) * 0.02;
        posArr[i * 3 + 2] = Math.cos(t * 3.5 + i * 1.3) * 0.02;
      }
      refs.tokenGeo.attributes.position.needsUpdate = true;
      refs.tokenMat.color.lerp(targetColors.pulse, 0.06);
      refs.tokenMat.opacity = 0.7 + sev * 0.2;
    }

    // ── Lights ──
    if (currentPhase === 'error' || sev > 0.5) {
      for (const lr of refs.lightRefs) {
        lr.light.color.lerp(new THREE.Color('#401010'), 0.05);
        lr.light.intensity += (lr.baseIntensity * 1.8 - lr.light.intensity) * 0.08;
      }
    } else {
      for (const lr of refs.lightRefs) {
        lr.light.color.lerp(lr.baseColor, 0.04);
        lr.light.intensity += (lr.baseIntensity - lr.light.intensity) * 0.06;
      }
    }

    // ── Bloom adapts ──
    if (bloomPass) {
      const targetBloom = (currentPhase === 'error' || sev > 0.4) ? 0.55 : 0.35;
      bloomPass.strength += (targetBloom - bloomPass.strength) * 0.06;
    }

    // ── Head dot material opacity scales with zoom ──
    if (refs.headDotMat) {
      const camDist = camera.position.distanceTo(controls.target);
      const dotOpacity = camDist < 8 ? 1.0 : Math.max(0.4, 1 - (camDist - 8) / 6);
      refs.headDotMat.opacity = dotOpacity;
    }

    composer.render();
  }

  requestAnimationFrame(animate);
}
