import React from "react";
import { useRuntimeStore } from "../runtimeStore";
import { resolveModelSpec } from "../morphology/modelRegistry";

/**
 * Subtle HUD overlay showing model name, architecture confidence,
 * and key morphology metadata (layer count, expert count, etc.)
 */
const ModelHeader: React.FC = () => {
  const modelId = useRuntimeStore((s) => s.modelId);
  const modelSpec = useRuntimeStore((s) => s.modelSpec);

  const spec = modelSpec || resolveModelSpec(modelId);

  const confidenceLabel =
    spec.architectureConfidence === "opaque"
      ? "OPAQUE / TELEMETRY DRIVEN"
      : spec.architectureConfidence === "partial"
        ? "PARTIAL METADATA"
        : "KNOWN ARCHITECTURE";

  const archLabel = spec.architectureClass
    .replace(/-/g, " ")
    .toUpperCase();

  return (
    <div style={styles.container}>
      <div style={styles.modelName}>{spec.displayName}</div>
      <div style={styles.detail}>
        <span style={{ color: spec.visual.baseColor }}>●</span>{" "}
        {archLabel}
      </div>
      <div style={styles.confidence}>{confidenceLabel}</div>
      {spec.transformer?.layers && typeof spec.transformer.layers === "number" && (
        <div style={styles.confidence}>
          {spec.transformer.layers}L · {typeof spec.attention?.heads === "number" ? `${spec.attention.heads}H` : ""}
        </div>
      )}
      {spec.moe?.experts && (
        <div style={styles.confidence}>
          MoE: {typeof spec.moe.experts === "number" ? spec.moe.experts : "?"} experts
          {typeof spec.moe.activeExperts === "number" ? ` (${spec.moe.activeExperts} active)` : ""}
        </div>
      )}
      {spec.visual.labels.map((label: string, i: number) => (
        <div key={i} style={styles.label}>{label}</div>
      ))}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: "fixed",
    top: 80,
    left: 20,
    zIndex: 10,
    pointerEvents: "none",
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 10,
    lineHeight: 1.5,
    opacity: 0.5,
  },
  modelName: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.1em",
    color: "rgba(200,220,240,0.7)",
    marginBottom: 2,
  },
  detail: {
    fontSize: 9,
    letterSpacing: "0.08em",
    color: "rgba(140,160,180,0.5)",
  },
  confidence: {
    fontSize: 8,
    letterSpacing: "0.07em",
    color: "rgba(100,120,140,0.4)",
  },
  label: {
    fontSize: 8,
    fontStyle: "italic",
    color: "rgba(80,100,120,0.35)",
  },
};

export default ModelHeader;
