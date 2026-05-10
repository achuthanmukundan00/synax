import React from "react";
import { useRuntimeStore } from "../runtimeStore";
import type { AgentPhase } from "../eventTypes";

const PHASE_LABELS: Record<AgentPhase, string> = {
  idle: "IDLE",
  perceive: "PERCEIVE",
  think: "THINK",
  decide: "DECIDE",
  act: "ACT",
  reflect: "REFLECT",
  remember: "REMEMBER",
  verify: "VERIFY",
  error: "ERROR",
};

const PHASE_COLORS: Record<AgentPhase, string> = {
  idle: "rgba(120,140,160,0.6)",
  perceive: "rgba(96,165,250,0.8)",
  think: "rgba(56,189,248,0.9)",
  decide: "rgba(250,204,21,0.8)",
  act: "rgba(245,158,11,0.9)",
  reflect: "rgba(167,139,250,0.8)",
  remember: "rgba(34,197,94,0.9)",
  verify: "rgba(167,139,250,0.9)",
  error: "rgba(255,42,42,0.95)",
};

const TelemetryOverlay: React.FC = () => {
  const phase = useRuntimeStore((s) => s.phase);
  const tokens = useRuntimeStore((s) => s.tokens);
  const contextPressure = useRuntimeStore((s) => s.contextPressure);
  const instability = useRuntimeStore((s) => s.instability);
  const activeTool = useRuntimeStore((s) => s.activeTool);
  const shell = useRuntimeStore((s) => s.shell);
  const verification = useRuntimeStore((s) => s.verification);
  const modelId = useRuntimeStore((s) => s.modelId);
  const isStreaming = useRuntimeStore((s) => s.isStreaming);

  const phaseColor = PHASE_COLORS[phase] || PHASE_COLORS.idle;

  return (
    <div style={styles.container}>
      {/* Top-left: model + phase */}
      <div style={styles.topLeft}>
        <div style={{ ...styles.modelId, color: phaseColor }}>
          {modelId || "synax"}
        </div>
        <div style={{ ...styles.phase, color: phaseColor }}>
          {PHASE_LABELS[phase]}
          {isStreaming && <span style={styles.streamingDot}> ●</span>}
        </div>
        {activeTool && (
          <div style={{ ...styles.tool, color: activeTool.risk === "high" ? "#ff003c" : "#f59e0b" }}>
            {activeTool.name.toUpperCase()}
            {activeTool.risk !== "low" && (
              <span style={{ color: activeTool.risk === "high" ? "#ff003c" : "#f59e0b" }}>
                {" "}[{activeTool.risk.toUpperCase()}]
              </span>
            )}
          </div>
        )}
      </div>

      {/* Top-right: token metrics */}
      <div style={styles.topRight}>
        {tokens.tokensPerSecond != null && (
          <div style={styles.metric}>
            <span style={styles.metricLabel}>TPS</span>
            <span style={styles.metricValue}>{tokens.tokensPerSecond.toFixed(1)}</span>
          </div>
        )}
        {tokens.total != null && tokens.maxContext != null && (
          <div style={styles.metric}>
            <span style={styles.metricLabel}>CTX</span>
            <span style={{
              ...styles.metricValue,
              color: contextPressure > 0.85 ? "#ff2a2a" : contextPressure > 0.65 ? "#f59e0b" : "rgba(200,220,240,0.8)",
            }}>
              {tokens.total}/{tokens.maxContext}
            </span>
          </div>
        )}
        <div style={styles.metric}>
          <span style={styles.metricLabel}>INST</span>
          <span style={{
            ...styles.metricValue,
            color: instability > 0.6 ? "#ff2a2a" : instability > 0.3 ? "#f59e0b" : "rgba(200,220,240,0.8)",
          }}>
            {(instability * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Bottom-right: shell command indicator */}
      {shell.activeCommand && (
        <div style={{
          ...styles.shellIndicator,
          borderColor: shell.risk === "high" ? "#ff003c" : shell.risk === "medium" ? "#f59e0b" : "rgba(100,140,180,0.3)",
        }}>
          <div style={{
            ...styles.shellLabel,
            color: shell.risk === "high" ? "#ff003c" : "#ef4444",
          }}>
            SHELL {shell.risk === "high" ? "⚠" : ""}
          </div>
          <div style={styles.shellCmd}>{shell.activeCommand.slice(0, 80)}</div>
          {shell.lastExitCode != null && (
            <div style={{
              ...styles.shellExit,
              color: shell.lastExitCode === 0 ? "#39ff88" : "#ff2a2a",
            }}>
              EXIT {shell.lastExitCode}
            </div>
          )}
        </div>
      )}

      {/* Verification indicator */}
      {verification.status && verification.status !== "idle" && (
        <div style={{
          ...styles.verifyIndicator,
          borderColor: verification.status === "pass" ? "#39ff88" : verification.status === "fail" ? "#ff2a2a" : "#a78bfa",
        }}>
          <span style={{
            color: verification.status === "pass" ? "#39ff88" : verification.status === "fail" ? "#ff2a2a" : "#a78bfa",
          }}>
            {verification.status.toUpperCase()}
          </span>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: "fixed",
    inset: 0,
    zIndex: 10,
    pointerEvents: "none",
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
    fontSize: 11,
    lineHeight: 1.4,
  },
  topLeft: {
    position: "absolute",
    top: 20,
    left: 20,
  },
  modelId: {
    fontSize: 10,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    marginBottom: 2,
  },
  phase: {
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: "0.16em",
    marginBottom: 4,
  },
  streamingDot: {
    animation: "none",
    opacity: 0.8,
  },
  tool: {
    fontSize: 10,
    letterSpacing: "0.1em",
    marginTop: 2,
  },
  topRight: {
    position: "absolute",
    top: 20,
    right: 24,
    display: "flex",
    gap: 16,
  },
  metric: {
    textAlign: "right",
  },
  metricLabel: {
    fontSize: 8,
    color: "rgba(120,140,160,0.5)",
    letterSpacing: "0.1em",
    display: "block",
  },
  metricValue: {
    color: "rgba(200,220,240,0.8)",
    fontSize: 12,
    fontWeight: 500,
  },
  shellIndicator: {
    position: "absolute",
    bottom: 32,
    right: 24,
    background: "rgba(8,4,4,0.92)",
    border: "1px solid rgba(255,0,60,0.3)",
    borderRadius: 6,
    padding: "8px 12px",
    maxWidth: 340,
  },
  shellLabel: {
    fontSize: 9,
    letterSpacing: "0.12em",
    fontWeight: 600,
    marginBottom: 3,
  },
  shellCmd: {
    fontSize: 11,
    color: "rgba(220,200,200,0.8)",
    wordBreak: "break-all",
  },
  shellExit: {
    fontSize: 10,
    marginTop: 3,
  },
  verifyIndicator: {
    position: "absolute",
    bottom: 32,
    left: 24,
    background: "rgba(8,8,20,0.9)",
    border: "1px solid rgba(167,139,250,0.4)",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 10,
    letterSpacing: "0.12em",
    fontWeight: 600,
  },
};

export default TelemetryOverlay;
