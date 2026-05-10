/**
 * Shoggoth Observer Server — minimal localhost HTTP + SSE relay.
 *
 * Serves the Vite-built web observer and provides:
 * - GET  /         → static index.html (from dist/ in production, proxies to Vite dev in dev mode)
 * - GET  /events   → SSE stream of telemetry events
 * - POST /ingest   → Synax pushes events here
 *
 * Events are buffered (last N) so late-connect SSE clients get recent history.
 * Read-only. Localhost only. No auth required.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type ShellRisk = "low" | "medium" | "high";

// ─── Configuration ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.SYNTH_OBSERVER_PORT ?? "8559", 10);
const HOST = "127.0.0.1";
const MAX_EVENT_BUFFER = 300;
const DIST_DIR = path.resolve(__dirname, "..", "dist");
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const IS_DEV = !fs.existsSync(DIST_DIR) || process.env.NODE_ENV === "development";
const STATIC_DIR = IS_DEV ? PUBLIC_DIR : DIST_DIR;

// ─── Event types ─────────────────────────────────────────────────────────────

export interface ObserverEvent {
  id: number;
  time: string;
  type: string;
  phase?: string;
  text?: string;
  tool?: {
    name: string;
    summary: string;
    status: string;
    arguments?: Record<string, unknown>;
    argsPreview?: string;
  };
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  risk?: ShellRisk;
  command?: string;
  exitCode?: number;
  path?: string;
  modelId?: string;
  providerName?: string;
}

// ─── State ───────────────────────────────────────────────────────────────────

let eventIdCounter = 0;
const eventBuffer: ObserverEvent[] = [];
const sseClients = new Set<http.ServerResponse>();

function broadcast(event: ObserverEvent): void {
  eventBuffer.push(event);
  if (eventBuffer.length > MAX_EVENT_BUFFER) {
    eventBuffer.shift();
  }

  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ─── MIME helpers ────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(res: http.ServerResponse, filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      serveStatic(res, path.join(filePath, "index.html"));
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] ?? "application/octet-stream";
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": String(body.length),
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    // SPA fallback: serve index.html for non-file routes
    const indexPath = path.join(STATIC_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      try {
        const body = fs.readFileSync(indexPath);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(body.length),
          "Cache-Control": "no-cache",
        });
        res.end(body);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
    }
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS for localhost Vite dev + observer
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  // SSE endpoint
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send buffered history
    for (const event of eventBuffer) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: "connected", count: eventBuffer.length })}\n\n`);

    sseClients.add(res);

    req.on("close", () => {
      sseClients.delete(res);
    });

    // Keepalive every 15s
    const keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        clearInterval(keepalive);
        sseClients.delete(res);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(keepalive);
    });

    return;
  }

  // Ingest endpoint — Synax pushes events here
  if (req.method === "POST" && url.pathname === "/ingest") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const raw = JSON.parse(body);

        // Handle batch events
        const events: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : [raw];

        for (const rawEvent of events) {
          const event = normalizeEvent(rawEvent);
          broadcast(event);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: events.length }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  // Static file serving
  if (req.method === "GET") {
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    // Security: prevent path traversal
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
    const fullPath = path.join(STATIC_DIR, filePath);
    // Ensure we don't escape STATIC_DIR
    if (!fullPath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    serveStatic(res, fullPath);
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
});

// ─── Event normalization (passthrough with ID enrichment) ─────────────────────

function normalizeEvent(raw: Record<string, unknown>): ObserverEvent {
  eventIdCounter += 1;

  const event: ObserverEvent = {
    id: eventIdCounter,
    time: (raw.time as string) ?? new Date().toISOString(),
    type: (raw.type as string) ?? "model_note",
  };

  // Passthrough all known fields
  if (raw.phase) event.phase = raw.phase as string;
  if (raw.text) event.text = raw.text as string;
  if (raw.contextUsedTokens != null) event.contextUsedTokens = raw.contextUsedTokens as number;
  if (raw.contextWindowTokens != null) event.contextWindowTokens = raw.contextWindowTokens as number;
  if (raw.modelId) event.modelId = raw.modelId as string;
  if (raw.providerName) event.providerName = raw.providerName as string;
  if (raw.risk) event.risk = raw.risk as ShellRisk;
  if (raw.command) event.command = raw.command as string;
  if (raw.exitCode != null) event.exitCode = raw.exitCode as number;
  if (raw.path) event.path = raw.path as string;

  // Tool call enrichment
  if (raw.tool) {
    event.tool = {
      name: (raw.tool as Record<string, unknown>).name as string ?? "unknown",
      summary: (raw.tool as Record<string, unknown>).summary as string ?? "",
      status: (raw.tool as Record<string, unknown>).status as string ?? "running",
    };
    if ((raw.tool as Record<string, unknown>).arguments) {
      event.tool.arguments = (raw.tool as Record<string, unknown>).arguments as Record<string, unknown>;
    }
    if ((raw.tool as Record<string, unknown>).argsPreview) {
      event.tool.argsPreview = (raw.tool as Record<string, unknown>).argsPreview as string;
    }
    // Also check top-level tool fields from older event format
    if (!event.risk && (raw.tool as Record<string, unknown>).severity) {
      event.risk = (raw.tool as Record<string, unknown>).severity as ShellRisk;
    }
  }

  // Legacy tool name/toolName fields
  if (!event.tool && (raw.toolName || raw.tool?.name)) {
    event.tool = {
      name: (raw.toolName as string) ?? (raw.tool?.name as string) ?? "unknown",
      summary: (raw.summary as string) ?? "",
      status: "running",
    };
  }

  return event;
}

// ─── Main ────────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log(`[shoggoth-observer] listening on http://${HOST}:${PORT}`);
  console.log(`[shoggoth-observer] SSE endpoint:  http://${HOST}:${PORT}/events`);
  console.log(`[shoggoth-observer] ingest endpoint: POST http://${HOST}:${PORT}/ingest`);
  console.log(`[shoggoth-observer] static dir: ${STATIC_DIR}`);
  console.log(`[shoggoth-observer] mode: ${IS_DEV ? "development (Vite dev proxy)" : "production (built dist)"}`);
  console.log(`[shoggoth-observer] Open http://${HOST}:${PORT} to watch the shoggoth.`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[shoggoth-observer] shutting down");
  for (const client of sseClients) {
    client.end();
  }
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  for (const client of sseClients) {
    client.end();
  }
  server.close(() => process.exit(0));
});
