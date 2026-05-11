import React, { Suspense, useMemo, useEffect, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { useRuntimeStore } from "./runtimeStore";

import ModelMorphologyRoot from "./morphology/ModelMorphologyRoot";
import TelemetryOverlay from "./overlays/TelemetryOverlay";
import ThoughtTranscript from "./overlays/ThoughtTranscript";
import ModelHeader from "./overlays/ModelHeader";

// ── Safe mode detection ─────────────────────────────────────────────────

function isSafeMode(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("safe") === "1";
}

const SAFE = isSafeMode();
const WIREFRAME = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("wireframe") === "1";

// ── WebGL context loss banner ───────────────────────────────────────────

const WebGLBanner: React.FC = () => {
  const [lost, setLost] = useState(false);

  useEffect(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return;

    const onLost = (e: Event) => {
      e.preventDefault();
      console.warn("[shoggoth] WebGL context lost");
      setLost(true);
    };
    const onRestored = () => {
      console.log("[shoggoth] WebGL context restored");
      setLost(false);
    };

    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, []);

  if (!lost) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.85)", color: "#ff4a4a",
      fontFamily: "monospace", fontSize: 14, pointerEvents: "none",
    }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>⚠</div>
        <div>WebGL context lost</div>
        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>Reload the page to restore</div>
      </div>
    </div>
  );
};

// ─── Main page ──────────────────────────────────────────────────────────

const ModelObserverPage: React.FC = () => {
  const instability = useRuntimeStore((s) => s.instability);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  // Show safe mode indicator
  useEffect(() => {
    if (SAFE) {
      console.log("[shoggoth] SAFE MODE — postprocessing disabled, particles capped, standard materials");
    }
  }, []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#000" }}>
      {/* Background gradient */}
      <div
        style={{
          position: "fixed", inset: 0, zIndex: 0,
          background: `
            radial-gradient(circle at 50% 40%, rgba(18, 36, 56, 0.22), transparent 45%),
            linear-gradient(180deg, #020407 0%, #000000 100%)
          `,
        }}
      />

      {/* Safe mode label */}
      {SAFE && (
        <div style={{
          position: "fixed", top: 20, right: 20, zIndex: 50,
          fontFamily: "monospace", fontSize: 9,
          color: "rgba(255,150,50,0.6)", pointerEvents: "none",
          letterSpacing: "0.1em",
        }}>
          SAFE MODE
        </div>
      )}

      {/* Three.js Canvas */}
      <div ref={canvasContainerRef} style={{ position: "fixed", inset: 0, zIndex: 1 }}>
        <Canvas
          camera={{
            position: [0, 2.5, 9],
            fov: 45,
            near: 0.1,
            far: 30,
          }}
          dpr={SAFE ? [1, 1] : [1, 1.5]}
          gl={{
            antialias: !SAFE,
            toneMapping: SAFE ? 0 : 3,
            toneMappingExposure: 1.1,
            alpha: false,
            powerPreference: "high-performance",
            preserveDrawingBuffer: false,
            failIfMajorPerformanceCaveat: false,
          }}
          onCreated={() => {
            console.log("[shoggoth] WebGL renderer created" + (WIREFRAME ? " (wireframe mode)" : ""));
          }}
        >
          <Suspense fallback={null}>
            {/* Lighting — brighter in safe mode for visibility */}
            <ambientLight intensity={SAFE ? 0.25 : 0.15} color="#1a2a40" />
            <pointLight position={[0, 3, 6]} intensity={SAFE ? 1.0 : 0.8} color="#4080b0" />
            <pointLight position={[-3, 0, -2]} intensity={0.25} color="#203850" />
            <pointLight position={[2, -1, 4]} intensity={0.3} color="#304868" />

            {/* Debug helpers — only in safe mode */}
            {SAFE && <DebugHelpers />}
            {WIREFRAME && <WireframeOverride />}

            {/* Faint origin marker — only in safe mode */}
            {SAFE && (
              <mesh position={[0, 0, 0]}>
                <sphereGeometry args={[0.04, 6, 6]} />
                <meshBasicMaterial color="#334466" transparent opacity={0.2} />
              </mesh>
            )}

            {/* Background specks */}
            <BackgroundSpecks />

            {/* Main morphology (includes agent orbit) */}
            <ModelMorphologyRoot />

            {/* Camera controls */}
            <OrbitControls
              makeDefault
              enablePan={false}
              enableDamping={true}
              dampingFactor={0.08}
              minDistance={3}
              maxDistance={20}
              maxPolarAngle={Math.PI * 0.72}
              target={[0, 0, 0]}
            />

            {/* Post-processing — disabled in safe mode */}
            {!SAFE && (
              <EffectComposer>
                <Bloom
                  luminanceThreshold={0.2}
                  luminanceSmoothing={0.9}
                  intensity={0.4 + instability * 0.15}
                  mipmapBlur
                />
              </EffectComposer>
            )}
          </Suspense>
        </Canvas>
      </div>

      {/* WebGL context loss banner */}
      <WebGLBanner />

      {/* HUD Overlays */}
      <TelemetryOverlay />
      <ModelHeader />
      <ThoughtTranscript />
    </div>
  );
};

// ── Wireframe override ──────────────────────────────────────────────────

const WireframeOverride: React.FC = () => {
  const { scene } = useThree();
  useEffect(() => {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x4080ff,
      wireframe: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    scene.overrideMaterial = mat;
    console.log("[shoggoth] wireframe overrideMaterial applied");
    return () => {
      scene.overrideMaterial = null;
      mat.dispose();
    };
  }, [scene]);
  return null;
};

// ── Background specks ───────────────────────────────────────────────────

const BackgroundSpecks: React.FC = () => {
  const count = SAFE ? 30 : 60;
  const positions = useMemo(
    () => new Float32Array(Array.from({ length: count * 3 }, () => (Math.random() - 0.5) * 14)),
    [count]
  );

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={positions}
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

// ── Debug helpers (safe mode only) ─────────────────────────────────────

const DebugHelpers: React.FC = () => {
  const axesHelper = useMemo(() => {
    const h = new THREE.AxesHelper(2.5);
    // Dim all axis colors — no bright red
    (h as any).setColors?.(
      new THREE.Color("#332222"),
      new THREE.Color("#223322"),
      new THREE.Color("#222233")
    );
    return h;
  }, []);

  return (
    <>
      <primitive object={axesHelper} />
      <primitive
        object={new THREE.GridHelper(12, 24, "#1a3050", "#0a1520")}
        position={[0, -2.5, 0]}
      />
      <primitive object={new THREE.PointLightHelper(
        new THREE.PointLight("#4080b0", 0.8), 0.15, "#4080b0"
      )} position={[0, 3, 6]} />
      <primitive object={new THREE.PointLightHelper(
        new THREE.PointLight("#203850", 0.25), 0.12, "#203850"
      )} position={[-3, 0, -2]} />
    </>
  );
};
