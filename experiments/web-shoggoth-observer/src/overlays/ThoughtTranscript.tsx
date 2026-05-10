import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRuntimeStore } from "../runtimeStore";
import type { TranscriptItem } from "../eventTypes";
import { LIMITS } from "../eventTypes";

/**
 * Transcript overlay below the morphology.
 * Shows model output, tool calls, tool results, memory searches,
 * verification status, errors, and shell commands.
 *
 * Scroll-locked to bottom. Bounded to MAX_TRANSCRIPT_ITEMS.
 */
const ThoughtTranscript: React.FC = () => {
  const recentEvents = useRuntimeStore((s) => s.recentEvents);
  const containerRef = useRef<HTMLDivElement>(null);

  // Derive transcript items from recent events
  const transcriptItems: TranscriptItem[] = React.useMemo(() => {
    const items: TranscriptItem[] = [];

    for (const event of recentEvents) {
      switch (event.type) {
        case "token": {
          // Merge consecutive tokens into one output item
          const last = items[items.length - 1];
          if (last && last.kind === "model_output") {
            last.text += event.text;
          } else {
            items.push({ kind: "model_output", text: event.text, time: Date.now() });
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
          // Phase transitions as notes
          if (event.phase === "error") {
            items.push({ kind: "error", text: "Agent phase: ERROR", time: Date.now() });
          }
          break;
        }
      }
    }

    return items.slice(-LIMITS.maxTranscriptItems);
  }, [recentEvents]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [transcriptItems.length]);

  const renderItem = (item: TranscriptItem, i: number) => {
    switch (item.kind) {
      case "model_output":
        return (
          <div key={i} style={styles.output}>
            <span style={styles.glyph}>▸</span>
            {item.text.slice(0, 400)}
          </div>
        );

      case "model_note":
        return (
          <div key={i} style={styles.note}>
            <span style={styles.glyph}>✦</span>
            {item.text}
          </div>
        );

      case "tool_call":
        return (
          <div key={i} style={{
            ...styles.toolCall,
            borderLeftColor: (item.risk ?? "low") === "high" ? "#ff003c" : (item.risk ?? "low") === "medium" ? "#f59e0b" : "#60a5fa",
          }}>
            <span style={{ ...styles.toolLabel, color: (item.risk ?? "low") === "high" ? "#ff003c" : "#f59e0b" }}>
              TOOL: {item.tool}
              {(item.risk ?? "low") !== "low" && ` [${(item.risk ?? "normal").toUpperCase()}]`}
            </span>
            <span style={styles.toolPreview}>{item.preview}</span>
          </div>
        );

      case "tool_result":
        return (
          <div key={i} style={{
            ...styles.toolResult,
            borderLeftColor: item.success ? "#39ff88" : "#ff2a2a",
          }}>
            <span style={{ color: item.success ? "#39ff88" : "#ff2a2a" }}>
              {item.success ? "✓" : "✗"} RESULT
            </span>
            <span style={styles.toolPreview}> {item.summary}</span>
          </div>
        );

      case "memory":
        return (
          <div key={i} style={{ ...styles.toolCall, borderLeftColor: "#22c55e" }}>
            <span style={{ color: "#22c55e" }}>MEMORY: {item.query}</span>
            {item.hitCount != null && (
              <span style={styles.toolPreview}> — {item.hitCount} hits</span>
            )}
          </div>
        );

      case "error":
        return (
          <div key={i} style={{ ...styles.toolCall, borderLeftColor: "#ff2a2a" }}>
            <span style={{ color: "#ff2a2a" }}>ERROR</span>
            <span style={styles.toolPreview}> {item.text}</span>
          </div>
        );

      case "verification":
        return (
          <div key={i} style={{
            ...styles.toolCall,
            borderLeftColor: item.status === "pass" ? "#39ff88" : item.status === "fail" ? "#ff2a2a" : "#a78bfa",
          }}>
            <span style={{
              color: item.status === "pass" ? "#39ff88" : item.status === "fail" ? "#ff2a2a" : "#a78bfa",
            }}>
              VERIFY: {item.status.toUpperCase()}
            </span>
          </div>
        );

      case "shell_command":
        return (
          <div key={i} style={{
            ...styles.toolCall,
            borderLeftColor: item.risk === "high" ? "#ff003c" : "#ef4444",
            background: item.risk === "high" ? "rgba(20,4,4,0.6)" : undefined,
          }}>
            <span style={{ color: "#ef4444" }}>
              SHELL{": "}
              <code style={styles.shellCode}>{item.command.slice(0, 120)}</code>
            </span>
            {item.exitCode != null && (
              <span style={{ color: item.exitCode === 0 ? "#39ff88" : "#ff2a2a" }}>
                {" "}→ {item.exitCode}
              </span>
            )}
          </div>
        );
    }
  };

  return (
    <div style={styles.wrapper}>
      <div ref={containerRef} style={styles.container}>
        <AnimatePresence>
          {transcriptItems.map((item, i) => (
            <motion.div
              key={`${item.kind}-${i}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              {renderItem(item, i)}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    maxHeight: "32vh",
    pointerEvents: "none",
  },
  container: {
    maxWidth: 920,
    width: "92vw",
    margin: "0 auto",
    padding: "0 24px 28px",
    overflowY: "auto",
    maxHeight: "32vh",
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 13,
    lineHeight: 1.5,
    scrollbarWidth: "none",
  },
  output: {
    color: "rgba(200,220,240,0.82)",
    marginBottom: 4,
    maxWidth: 760,
    wordBreak: "break-word",
  },
  note: {
    color: "rgba(160,180,200,0.7)",
    marginBottom: 4,
    fontStyle: "italic",
  },
  toolCall: {
    color: "rgba(255,190,90,0.9)",
    borderLeft: "2px solid rgba(96,165,250,0.5)",
    paddingLeft: 10,
    marginBottom: 3,
    fontSize: 12,
  },
  toolLabel: {
    fontWeight: 600,
    marginRight: 6,
  },
  toolPreview: {
    color: "rgba(180,200,220,0.6)",
    fontSize: 11,
  },
  toolResult: {
    color: "rgba(180,200,220,0.7)",
    borderLeft: "2px solid rgba(100,180,140,0.4)",
    paddingLeft: 10,
    marginBottom: 3,
    fontSize: 11,
  },
  shellCode: {
    fontFamily: "inherit",
    fontSize: 11,
    opacity: 0.9,
  },
  glyph: {
    marginRight: 6,
    opacity: 0.4,
  },
};

export default ThoughtTranscript;
