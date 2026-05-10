import React from "react";
import { useRuntimeStore } from "../runtimeStore";
import { resolveModelSpec } from "../morphology/modelRegistry";

const ModelHeader: React.FC = () => {
  const modelId = useRuntimeStore((s) => s.modelId);
  const modelSpec = useRuntimeStore((s) => s.modelSpec);

  const spec = modelSpec || resolveModelSpec(modelId);

  // Derive truth label
  const truthLabel =
    spec.architectureConfidence === "opaque"
      ? "provider-inferred + simulated morphology"
      : spec.architectureConfidence === "partial"
        ? "provider-inferred + telemetry driven"
        : "known architecture + telemetry driven";

  // Derive architecture display
  const archClass = spec.architectureClass;
  let archLabel: string;
  if (archClass === "opaque-frontier-model") archLabel = "GENERALIZED REASONING CORE";
  else if (archClass === "moe-transformer") archLabel = "MOE / EXPERT FIELD";
  else if (archClass === "dense-transformer" || archClass === "small-dense-transformer") archLabel = "DENSE TRANSFORMER";
  else if (archClass === "coding-optimized-transformer") archLabel = "CODING TRANSFORMER";
  else if (archClass === "reasoning-optimized-transformer") archLabel = "REASONING CORE";
  else archLabel = archClass.replace(/-/g, " ").toUpperCase();

  // Provider display
  const providerLabel = spec.provider
    ? spec.provider.toUpperCase()
    : spec.architectureConfidence === "opaque" ? "FRONTIER API" : "LOCAL";

  return (
    <div style={styles.container}>
      <div style={styles.modelName}>{spec.displayName}</div>
      <div style={styles.detail}>
        <span style={{ color: spec.visual.baseColor }}>●</span>{" "}
        {providerLabel}
      </div>
      <div style={styles.archLabel}>{archLabel}</div>
      <div style={styles.truthLabel}>{truthLabel}</div>
      {spec.family && (
        <div style={styles.meta}>family: {spec.family}</div>
      )}
      {spec.visual.labels.length > 0 && (
        <div style={styles.labels}>
          {spec.visual.labels.map((label: string, i: number) => (
            <div key={i} style={styles.label}>{label}</div>
          ))}
        </div>
      )}
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
    opacity: 0.55,
    maxWidth: 260,
  },
  modelName: {
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.1em",
    color: "rgba(200,220,240,0.7)",
    marginBottom: 3,
  },
  detail: {
    fontSize: 9,
    letterSpacing: "0.08em",
    color: "rgba(140,160,180,0.5)",
    marginBottom: 1,
  },
  archLabel: {
    fontSize: 9,
    letterSpacing: "0.09em",
    color: "rgba(160,190,210,0.55)",
    fontWeight: 500,
    marginBottom: 2,
  },
  truthLabel: {
    fontSize: 8,
    letterSpacing: "0.06em",
    color: "rgba(90,110,130,0.4)",
    fontStyle: "italic",
    marginBottom: 4,
  },
  meta: {
    fontSize: 8,
    color: "rgba(70,90,110,0.35)",
  },
  labels: {
    marginTop: 3,
  },
  label: {
    fontSize: 8,
    fontStyle: "italic",
    color: "rgba(80,100,120,0.3)",
    lineHeight: 1.3,
  },
};

export default ModelHeader;
