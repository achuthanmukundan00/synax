import React, { useEffect, useRef } from "react";
import { useRuntimeStore } from "../runtimeStore";
import type { TranscriptItem } from "../eventTypes";
import { LIMITS } from "../eventTypes";

const ThoughtTranscript: React.FC = () => {
  const recentEvents = useRuntimeStore((s) => s.recentEvents);
  const containerRef = useRef<HTMLDivElement>(null);

  const transcriptItems: TranscriptItem[] = React.useMemo(() => {
    const items: TranscriptItem[] = [];
    for (const event of recentEvents) {
      switch (event.type) {
        case "token": {
          // Sanitize: strip <thinking> blocks
          const clean = event.text.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, "").trim();
          if (!clean) break;
          const last = items[items.length - 1];
          if (last && last.kind === "model_output") {
            last.text += clean;
          } else {
            items.push({ kind: "model_output", text: clean, time: Date.now() });
          }
          break;
        }
        case "tool_call": {
          items.push({
            kind: "tool_call",
            tool: event.tool,
            preview: event.argsPreview.slice(0, 200),
            risk: event.risk,
            time: event.timestamp,
          });
          break;
        }
        case "tool_result": {
          items.push({
            kind: "tool_result",
            summary: event.summary.slice(0, 200),
            success: event.success,
            time: Date.now(),
          });
          break;
        }
        case "memory_search": {
          items.push({
            kind: "memory",
            query: event.query,
            hitCount: event.hitCount,
            time: Date.now(),
          });
          break;
        }
        case "error_event": {
          items.push({ kind: "error", text: event.message, time: Date.now() });
          break;
        }
        case "verification": {
          items.push({
            kind: "verification",
            status: event.status,
            time: Date.now(),
          });
          break;
        }
        case "shell_command": {
          items.push({
            kind: "shell_command",
            command: event.command,
            risk: event.risk,
            exitCode: event.exitCode,
            time: Date.now(),
          });
          break;
        }
        case "phase": {
          if (event.phase === "error") {
            items.push({ kind: "error", text: "agent phase: ERROR", time: Date.now() });
          }
          break;
        }
      }
    }
    return items.slice(-LIMITS.maxTranscriptItems);
  }, [recentEvents]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [transcriptItems.length]);

  return (
    <div style={s.panel}>
      {/* Top-edge gradient fade */}
      <div style={s.fade} />

      {/* Header bar */}
      <div style={s.header}>
        <span style={s.headerDot}>●</span>
        <span style={s.headerText}>OBSERVER CONSOLE</span>
        <span style={s.headerCount}>{transcriptItems.length} entries</span>
      </div>

      {/* Scrollable content */}
      <div ref={containerRef} style={s.body}>
        {transcriptItems.length === 0 && (
          <div style={s.empty}>waiting for agent events…</div>
        )}
        {transcriptItems.map((item, i) => (
          <div key={`${item.kind}-${i}`} style={s.row}>
            {renderItem(item)}
          </div>
        ))}
      </div>
    </div>
  );
};

function renderItem(item: TranscriptItem) {
  const ts = new Date(item.time).toLocaleTimeString("en-US", { hour12: false });

  switch (item.kind) {
    case "model_output": {
      const text = item.text.slice(0, 500);
      return (
        <>
          <span style={s.ts}>{ts}</span>
          <span style={s.markerOutput}>▸</span>
          <span style={s.outputText}>{text}</span>
        </>
      );
    }

    case "model_note": {
      return (
        <>
          <span style={s.ts}>{ts}</span>
          <span style={s.markerNote}>✦</span>
          <span style={s.noteText}>{item.text}</span>
        </>
      );
    }

    case "tool_call": {
      const riskColor = (item.risk ?? "low") === "high" ? "#ff003c" : (item.risk ?? "low") === "medium" ? "#f59e0b" : "#60a5fa";
      return (
        <>
          <span style={s.ts}>{ts}</span>
          <span style={{ ...s.markerTool, color: riskColor }}>$</span>
          <span style={{ ...s.toolName, color: riskColor }}>{item.tool}</span>
          <span style={s.toolArgs}>{item.preview}</span>
          {(item.risk ?? "low") !== "low" && (
            <span style={{ ...s.riskBadge, color: riskColor }}>
              {(item.risk ?? "normal").toUpperCase()}
            </span>
          )}
        </>
      );
    }

    case "tool_result": {
      return (
        <>
          <span style={s.ts}>{ts}</span>
          <span style={{ ...s.markerResult, color: item.success ? "#39ff88" : "#ff2a2a" }}>
            {item.success ? "✓" : "✗"}
          </span>
          <span style={{ ...s.resultText, color: item.success ? "rgba(160,220,180,0.7)" : "rgba(255,120,120,0.8)" }}>
            {item.summary}
          </span>
        </>
      );
    }

    case "memory": {
      return (
        <>
          <span style={s.ts}>{ts}</span>
          <span style={{ ...s.markerTool, color: "#22c55e" }}>M</span>
          <span style={{ color: "#22c55e", fontSize: 11 }}>{item.query}</span>
          {item.hitCount != null && (
            <span style={{ color: "rgba(34,197,94,0.5)", fontSize: 10, marginLeft: 6 }}>
              {item.hitCount} hits
            </span>
          )}
        </>
      );
    }

    case "error": {
      return (
        <>
          <span style={s.ts}>{ts}</span>
          <span style={{ ...s.markerResult, color: "#ff2a2a" }}>!</span>
          <span style={{ color: "#ff6060", fontSize: 11 }}>{item.text}</span>
        </>
      );
    }

    case "verification": {
      const vColor = item.status === "pass" ? "#39ff88" : item.status === "fail" ? "#ff2a2a" : "#a78bfa";
      return (
        <>
          <span style={s.ts}>{ts}</span>
          <span style={{ ...s.markerResult, color: vColor }}>
            {item.status === "pass" ? "✓" : item.status === "fail" ? "✗" : "⟳"}
          </span>
          <span style={{ color: vColor, fontSize: 11 }}>verify: {item.status.toUpperCase()}</span>
        </>
      );
    }

    case "shell_command": {
      return (
        <>
          <span style={s.ts}>{ts}</span>
          <span style={{ ...s.markerTool, color: "#ef4444" }}>$</span>
          <code style={s.shellCode}>{item.command.slice(0, 120)}</code>
          {item.exitCode != null && (
            <span style={{
              color: item.exitCode === 0 ? "#39ff88" : "#ff2a2a",
              marginLeft: 6, fontSize: 10,
            }}>
              → {item.exitCode}
            </span>
          )}
        </>
      );
    }

    default:
      return null;
  }
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    position: "fixed",
    bottom: 0,
    left: "50%",
    transform: "translateX(-50%)",
    width: "min(820px, 94vw)",
    maxHeight: "28vh",
    zIndex: 15,
    background: "rgba(4, 8, 18, 0.94)",
    border: "1px solid rgba(60, 90, 130, 0.2)",
    borderBottom: "none",
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    display: "flex",
    flexDirection: "column",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    boxShadow: "0 -4px 24px rgba(0,0,0,0.6)",
    pointerEvents: "auto",
  },
  fade: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 12,
    background: "linear-gradient(180deg, rgba(4,8,18,0.3) 0%, transparent 100%)",
    zIndex: 2,
    pointerEvents: "none",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 14px",
    borderBottom: "1px solid rgba(60,90,130,0.12)",
    flexShrink: 0,
  },
  headerDot: {
    color: "#39ff88",
    fontSize: 8,
  },
  headerText: {
    color: "rgba(120,150,180,0.5)",
    fontSize: 9,
    letterSpacing: "0.14em",
    fontWeight: 600,
    textTransform: "uppercase" as const,
  },
  headerCount: {
    color: "rgba(80,100,120,0.35)",
    fontSize: 9,
    marginLeft: "auto",
  },
  body: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "10px 14px 14px",
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
    fontSize: 12,
    lineHeight: 1.45,
    scrollbarWidth: "thin" as const,
    scrollbarColor: "rgba(60,90,130,0.2) transparent",
  },
  empty: {
    color: "rgba(80,100,130,0.35)",
    fontStyle: "italic",
    fontSize: 11,
    textAlign: "center" as const,
    paddingTop: 20,
  },
  row: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    marginBottom: 3,
    flexWrap: "wrap" as const,
    paddingLeft: 0,
  },
  ts: {
    color: "rgba(60,80,100,0.35)",
    fontSize: 9,
    fontFamily: "monospace",
    flexShrink: 0,
    minWidth: 52,
  },
  markerOutput: {
    color: "rgba(140,170,200,0.35)",
    fontSize: 10,
    flexShrink: 0,
  },
  markerNote: {
    color: "rgba(160,140,200,0.4)",
    fontSize: 10,
    flexShrink: 0,
  },
  markerTool: {
    fontWeight: 700,
    fontSize: 11,
    flexShrink: 0,
    fontFamily: "monospace",
  },
  markerResult: {
    fontWeight: 700,
    fontSize: 11,
    flexShrink: 0,
  },
  outputText: {
    color: "rgba(180,200,220,0.78)",
    fontSize: 12,
    wordBreak: "break-word" as const,
    maxWidth: "100%",
  },
  noteText: {
    color: "rgba(140,160,190,0.55)",
    fontSize: 11,
    fontStyle: "italic" as const,
    wordBreak: "break-word" as const,
  },
  toolName: {
    fontWeight: 600,
    fontSize: 11,
    flexShrink: 0,
    fontFamily: "monospace",
  },
  toolArgs: {
    color: "rgba(160,180,200,0.5)",
    fontSize: 10,
    wordBreak: "break-word" as const,
  },
  riskBadge: {
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: "0.08em",
    marginLeft: 4,
    flexShrink: 0,
  },
  resultText: {
    fontSize: 11,
    wordBreak: "break-word" as const,
  },
  shellCode: {
    fontFamily: "'SF Mono', 'Cascadia Code', monospace",
    fontSize: 10,
    color: "rgba(255,140,140,0.85)",
    wordBreak: "break-all" as const,
  },
};

export default ThoughtTranscript;
