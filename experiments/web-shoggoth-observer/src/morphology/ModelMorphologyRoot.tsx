import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntimeStore } from "../runtimeStore";
import { resolveModelSpec, resolveVisualParams } from "./modelRegistry";
import { DEFAULT_SPEC } from "./modelRegistry";
import type { ResolvedVisualParams } from "./modelRegistry";

// Morphology components
import OpaqueFrontierCore from "./components/OpaqueFrontierCore";
import TransformerBackbone from "./components/TransformerBackbone";
import ExpertBanks from "./components/ExpertBanks";
import RouterGates from "./components/RouterGates";
import ContextRails from "./components/ContextRails";
import TokenParticles from "./components/TokenParticles";

/**
 * Root morphology selector. Reads the current model spec and phase
 * from the runtime store and renders the appropriate 3D morphology:
 *
 *   - Opaque frontier API models → sealed glass core + reasoning shells
 *   - Dense transformers → vertical reactor stack with bands/rings
 *   - MoE transformers → backbone + radial expert banks + router gates
 *   - Reasoning-optimized → nested recursive shells
 *   - Coding-optimized → backbone + external tool/file orbit (agent orbit rendered separately)
 */
const ModelMorphologyRoot: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const shakeOffset = useRef(new THREE.Vector3());

  // Runtime state
  const modelId = useRuntimeStore((s) => s.modelId);
  const phase = useRuntimeStore((s) => s.phase);
  const isStreaming = useRuntimeStore((s) => s.isStreaming);
  const instability = useRuntimeStore((s) => s.instability);
  const contextPressure = useRuntimeStore((s) => s.contextPressure);
  const recentEvents = useRuntimeStore((s) => s.recentEvents);

  // Resolve model spec
  const spec = useMemo(() => {
    // Try to detect from events
    const switchEvent = recentEvents.find((e) => e.type === "model_switch");
    if (switchEvent && switchEvent.type === "model_switch") {
      return resolveModelSpec(switchEvent.modelId, switchEvent.provider);
    }
    return resolveModelSpec(modelId);
  }, [modelId, recentEvents]);

  const params: ResolvedVisualParams = useMemo(() => resolveVisualParams(spec), [spec]);

  const { layerCount, attentionHeads, expertBanks, visibleExperts, activeExpertsPerToken } = params;
  const stackLength = 7.2 * params.scaleMultiplier;

  // Cascade animation state
  const cascadeRef = useRef({ active: false, startTime: 0, progress: 0 });
  const CASCADE_DURATION = 1.8;
  const CASCADE_COOLDOWN = 0.6;

  // Phase → cascade trigger
  const prevPhase = useRef(phase);
  if (phase !== prevPhase.current) {
    prevPhase.current = phase;
    if (phase === "think" || phase === "act") {
      cascadeRef.current.active = true;
      cascadeRef.current.startTime = performance.now() / 1000;
    }
  }

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const dt = Math.min(state.clock.getDelta(), 0.1);

    // Cascade progress
    const c = cascadeRef.current;
    if (c.active) {
      const elapsed = t - c.startTime;
      if (elapsed > CASCADE_DURATION + CASCADE_COOLDOWN) {
        c.active = false;
        c.progress = 1.0;
      } else if (elapsed < 0) {
        c.progress = 0;
      } else {
        c.progress = Math.min(elapsed / CASCADE_DURATION, 1.0);
      }
    }

    // Error shake
    const targetShake = (phase === "error" || instability > 0.5) ? instability * 0.06 : 0;
    const currentShake = shakeOffset.current.length();
    const newShake = currentShake + (targetShake - currentShake) * 0.12;

    if (newShake > 0.001) {
      shakeOffset.current.set(
        Math.sin(t * 22) * newShake + Math.cos(t * 35 + 1.3) * newShake * 0.5,
        Math.cos(t * 25 + 2.1) * newShake + Math.sin(t * 40 + 0.7) * newShake * 0.4,
        Math.sin(t * 28 + 1.8) * newShake * 0.3,
      );
      if (groupRef.current) groupRef.current.position.copy(shakeOffset.current);
    } else {
      if (groupRef.current) groupRef.current.position.set(0, 0, 0);
    }

    // Slow orbital rotation
    if (groupRef.current) {
      groupRef.current.rotation.y += dt * 0.03;
      groupRef.current.rotation.x += dt * 0.005;
    }

    // Breathing
    if (groupRef.current) {
      const breath = 1 + Math.sin(t * 0.35) * 0.005 + instability * 0.012;
      groupRef.current.scale.setScalar(breath);
    }
  });

  const isOpaque =
    spec.architectureClass === "opaque-frontier-model" ||
    spec.architectureConfidence === "opaque";

  const isDense = spec.architectureClass === "dense-transformer" ||
    spec.architectureClass === "small-dense-transformer";

  const isMoE = spec.architectureClass === "moe-transformer" ||
    spec.architectureClass === "hybrid-moe-transformer";

  const isReasoning = spec.architectureClass === "reasoning-optimized-transformer";

  return (
    <group ref={groupRef}>
      {/* Context rails — always present when telemetry exists */}
      <ContextRails
        params={params}
        stackLength={stackLength}
        contextPressure={contextPressure}
      />

      {/* Core morphology — selected by architecture class */}
      {isOpaque || isReasoning ? (
        <OpaqueFrontierCore
          params={params}
          streaming={isStreaming}
          phase={phase}
          instability={instability}
          contextPressure={contextPressure}
        />
      ) : isDense ? (
        <TransformerBackbone
          params={params}
          layerCount={layerCount}
          attentionHeads={attentionHeads}
          streaming={isStreaming}
          phase={phase}
          instability={instability}
          cascadeProgress={cascadeRef.current.progress}
        />
      ) : isMoE ? (
        <>
          <TransformerBackbone
            params={params}
            layerCount={layerCount}
            attentionHeads={attentionHeads}
            streaming={isStreaming}
            phase={phase}
            instability={instability}
            cascadeProgress={cascadeRef.current.progress}
          />
          <RouterGates
            params={params}
            streaming={isStreaming}
            phase={phase}
            instability={instability}
          />
          <ExpertBanks
            params={params}
            stackLength={stackLength}
            expertBanks={expertBanks}
            visibleExperts={visibleExperts}
            activeExpertsPerToken={activeExpertsPerToken}
            streaming={isStreaming}
            phase={phase}
            instability={instability}
            truth="simulated"
          />
        </>
      ) : (
        // Unknown / fallback: opaque core + token particles
        <>
          <OpaqueFrontierCore
            params={params}
            streaming={isStreaming}
            phase={phase}
            instability={instability}
            contextPressure={contextPressure}
          />
          <TokenParticles
            params={params}
            stackLength={stackLength}
            streaming={isStreaming}
            instability={instability}
          />
        </>
      )}
    </group>
  );
};

export default ModelMorphologyRoot;
