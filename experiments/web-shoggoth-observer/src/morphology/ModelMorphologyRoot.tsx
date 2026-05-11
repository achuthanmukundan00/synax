import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntimeStore } from "../runtimeStore";
import { resolveModelSpec, resolveVisualParams } from "./modelRegistry";
import type { ResolvedVisualParams } from "./modelRegistry";

import OpaqueFrontierCore from "./components/OpaqueFrontierCore";
import TransformerBackbone from "./components/TransformerBackbone";
import ExpertBanks from "./components/ExpertBanks";
import RouterGates from "./components/RouterGates";
import ContextRails from "./components/ContextRails";
import TokenParticles from "./components/TokenParticles";
import AgentRuntimeOrbit from "../agent/AgentRuntimeOrbit";

const ModelMorphologyRoot: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const shakeOffset = useRef(new THREE.Vector3());

  const modelId = useRuntimeStore((s) => s.modelId);
  const phase = useRuntimeStore((s) => s.phase);
  const isStreaming = useRuntimeStore((s) => s.isStreaming);
  const instability = useRuntimeStore((s) => s.instability);
  const contextPressure = useRuntimeStore((s) => s.contextPressure);
  const recentEvents = useRuntimeStore((s) => s.recentEvents);

  // Resolve model spec from SSE events or store
  const spec = useMemo(() => {
    const switchEvent = recentEvents.find((e) => e.type === "model_switch");
    if (switchEvent && switchEvent.type === "model_switch") {
      return resolveModelSpec(switchEvent.modelId, switchEvent.provider);
    }
    return resolveModelSpec(modelId);
  }, [modelId, recentEvents]);

  const params: ResolvedVisualParams = useMemo(() => resolveVisualParams(spec), [spec]);

  const { layerCount, attentionHeads, expertBanks, visibleExperts, activeExpertsPerToken } = params;
  const stackLength = 4.0 * params.scaleMultiplier;

  // Cascade animation state
  const cascadeRef = useRef({ active: false, startTime: 0, progress: 0 });
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

    const c = cascadeRef.current;
    if (c.active) {
      const elapsed = t - c.startTime;
      c.progress = elapsed < 0 ? 0 : Math.min(elapsed / 1.8, 1.0);
      if (c.progress >= 1.0) c.active = false;
    }

    // Shake — capped to avoid violent UI oscillation at high instability.
    // Max amplitude: 0.025 world units. Max frequency: ~15 Hz composite.
    const shakeAmp = Math.min(instability, 0.85) * 0.025;
    const targetShake = (phase === "error" || instability > 0.5) ? shakeAmp : 0;
    const curShake = shakeOffset.current.length();
    const newShake = curShake + (targetShake - curShake) * 0.12;
    if (newShake > 0.001) {
      shakeOffset.current.set(
        Math.sin(t * 8) * newShake + Math.cos(t * 13 + 1.3) * newShake * 0.5,
        Math.cos(t * 10 + 2.1) * newShake + Math.sin(t * 15 + 0.7) * newShake * 0.4,
        Math.sin(t * 11 + 1.8) * newShake * 0.3,
      );
      if (groupRef.current) groupRef.current.position.copy(shakeOffset.current);
    } else if (groupRef.current) {
      groupRef.current.position.set(0, 0, 0);
    }

    // Rotation + breathing
    if (groupRef.current) {
      groupRef.current.rotation.y += dt * 0.03;
      groupRef.current.rotation.x += dt * 0.005;
      const breathSpeed = isStreaming ? 0.8 : 0.45;
      const breath = 1 + Math.sin(t * breathSpeed) * (isStreaming ? 0.015 : 0.008) + instability * 0.015;
      groupRef.current.scale.setScalar(breath);
    }
  });

  // ── Architecture class dispatch ───────────────────────────────────────
  const archClass = spec.architectureClass;
  // Only actual frontier API models (OpenAI, Anthropic, Google) get the opaque capsule.
  // Unknown / fallback models get the dense transformer backbone.
  const isOpaque = archClass === "opaque-frontier-model";
  const isDense = archClass === "dense-transformer" || archClass === "small-dense-transformer" || archClass === "unknown-transformer-family";
  const isMoE = archClass === "moe-transformer" || archClass === "hybrid-moe-transformer";
  const isReasoning = archClass === "reasoning-optimized-transformer";
  const isCoding = archClass === "coding-optimized-transformer";

  // All morphologies get context rails + token particles
  const common = (
    <>
      <ContextRails params={params} stackLength={stackLength} contextPressure={contextPressure} />
      <TokenParticles params={params} stackLength={stackLength} streaming={isStreaming} instability={instability} />
    </>
  );

  return (
    <group ref={groupRef} key={spec.id}>
      {isMoE && (
        <>
          <TransformerBackbone
            params={params} layerCount={layerCount} attentionHeads={attentionHeads}
            streaming={isStreaming} phase={phase} instability={instability}
            cascadeProgress={cascadeRef.current.progress}
          />
          <RouterGates params={params} streaming={isStreaming} phase={phase} instability={instability} />
          <ExpertBanks
            params={params} stackLength={stackLength}
            expertBanks={expertBanks} visibleExperts={visibleExperts}
            activeExpertsPerToken={activeExpertsPerToken}
            streaming={isStreaming} phase={phase} instability={instability} truth="simulated"
          />
          {common}
        </>
      )}

      {isDense && (
        <>
          <TransformerBackbone
            params={params} layerCount={layerCount} attentionHeads={attentionHeads}
            streaming={isStreaming} phase={phase} instability={instability}
            cascadeProgress={cascadeRef.current.progress}
          />
          {common}
        </>
      )}

      {isCoding && (
        <>
          <TransformerBackbone
            params={params} layerCount={layerCount} attentionHeads={attentionHeads}
            streaming={isStreaming} phase={phase} instability={instability}
            cascadeProgress={cascadeRef.current.progress}
          />
          {common}
        </>
      )}

      {(isOpaque || isReasoning) && (
        <>
          <OpaqueFrontierCore
            params={params} streaming={isStreaming} phase={phase}
            instability={instability} contextPressure={contextPressure}
          />
          {common}
        </>
      )}

      {/* Agent orbit inside the core group so it moves with it */}
      <AgentRuntimeOrbit />
    </group>
  );
};

export default ModelMorphologyRoot;
