import React, { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { useRuntimeStore } from "./runtimeStore";

// 3D Core
import ModelMorphologyRoot from "./morphology/ModelMorphologyRoot";
import AgentRuntimeOrbit from "./agent/AgentRuntimeOrbit";

// HTML Overlays
import TelemetryOverlay from "./overlays/TelemetryOverlay";
import ThoughtTranscript from "./overlays/ThoughtTranscript";
import ModelHeader from "./overlays/ModelHeader";

/**
 * Main observer page — fullscreen dark sci-fi Three.js visualization.
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │         [ live model morphology ]       │
 *   │     phase rings / context rails /       │
 *   │     memory / tool orbit                 │
 *   │─────────────────────────────────────────│
 *   │  model notes / streamed output /        │
 *   │  tool calls / verification              │
 *   └─────────────────────────────────────────┘
 */
const ModelObserverPage: React.FC = () => {
  const instability = useRuntimeStore((s) => s.instability);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#000" }}>
      {/* Background gradient layer */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: `
            radial-gradient(circle at 50% 40%, rgba(18, 36, 56, 0.22), transparent 45%),
            linear-gradient(180deg, #020407 0%, #000000 100%)
          `,
          zIndex: 0,
        }}
      />

      {/* Three.js Canvas */}
      <div style={{ position: "fixed", inset: 0, zIndex: 1 }}>
        <Canvas
          camera={{
            position: [0, 0.5, 8],
            fov: 45,
            near: 0.1,
            far: 30,
          }}
          dpr={[1, 1.5]}
          gl={{
            antialias: true,
            toneMapping: 3, // ACESFilmic
            toneMappingExposure: 1.1,
            alpha: false,
          }}
        >
          <Suspense fallback={null}>
            {/* Ambient + key lighting */}
            <ambientLight intensity={0.06} color="#0a1420" />
            <pointLight position={[0, 3, 4]} intensity={0.5} color="#306080" />
            <pointLight position={[-2, -1, 2]} intensity={0.15} color="#182838" />

            {/* Background specks */}
            <BackgroundSpecks />

            {/* Main morphology */}
            <ModelMorphologyRoot />

            {/* Agent runtime orbit */}
            <AgentRuntimeOrbit />

            {/* Post-processing bloom */}
            <EffectComposer>
              <Bloom
                luminanceThreshold={0.2}
                luminanceSmoothing={0.9}
                intensity={0.4 + instability * 0.15}
                mipmapBlur
              />
            </EffectComposer>
          </Suspense>
        </Canvas>
      </div>

      {/* HUD Overlays */}
      <TelemetryOverlay />
      <ModelHeader />

      {/* Transcript */}
      <ThoughtTranscript />
    </div>
  );
};

/**
 * Faint distant particle specks for depth / holographic chamber feel.
 */
const BackgroundSpecks: React.FC = () => {
  const count = 60;

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={new Float32Array(
            Array.from({ length: count * 3 }, () => (Math.random() - 0.5) * 14)
          )}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.015}
        color="#1a2a40"
        transparent
        opacity={0.15}
        depthWrite={false}
      />
    </points>
  );
};

export default ModelObserverPage;
