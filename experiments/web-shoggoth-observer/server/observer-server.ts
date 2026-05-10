/**
 * Shoggoth Observer Server — minimal localhost HTTP + SSE relay.
 *
 * Serves the static web observer and provides:
 * - GET  /         → static index.html
 * - GET  /events   → SSE stream of telemetry events
 * - POST /ingest   → Synax pushes events here
 *
 * Events are buffered (last N) so late-connect SSE clients get recent history.
 * Read-only. Localhost only. No auth required.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeToolCall, type ToolSeverity } from './suspicious-tool-heuristics';

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.SYNTH_OBSERVER_PORT ?? '8559', 10);
const HOST = '127.0.0.1';
const MAX_EVENT_BUFFER = 200;
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// ─── Event types (mirror what Synax emits) ───────────────────────────────────

export interface ObserverEvent {
  id: number;
  time: string;
  type:
    | 'session_started'
    | 'model_note'
    | 'assistant_delta'
    | 'tool_call_started'
    | 'tool_call_finished'
    | 'tool_call_failed'
    | 'warning'
    | 'error'
    | 'session_finished'
    | 'budget_update';
  phase: 'idle' | 'thinking' | 'streaming' | 'tool_pending' | 'tool_running' | 'error' | 'completed' | 'blocked';
  text?: string;
  tool?: {
    name: string;
    summary: string;
    status: 'queued' | 'running' | 'completed' | 'failed';
    severity: ToolSeverity;
    reasons?: string[];
    timestamp: string;
  };
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  severity?: ToolSeverity;
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
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res: http.ServerResponse, filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      serveStatic(res, path.join(filePath, 'index.html'));
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] ?? 'application/octet-stream';
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS for localhost observer
  res.setHeader('Access-Control-Allow-Origin', `http://${HOST}:${PORT}`);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  // SSE endpoint
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send buffered history
    for (const event of eventBuffer) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: 'connected', count: eventBuffer.length })}\n\n`);

    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });

    // Keepalive every 15s
    const keepalive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepalive);
        sseClients.delete(res);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepalive);
    });

    return;
  }

  // Ingest endpoint — Synax pushes events here
  if (req.method === 'POST' && url.pathname === '/ingest') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const raw = JSON.parse(body);

        // Handle batch events
        const events: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : [raw];

        for (const rawEvent of events) {
          const event = normalizeEvent(rawEvent);
          broadcast(event);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: events.length }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  // Static file serving
  if (req.method === 'GET') {
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    // Security: prevent path traversal
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(PUBLIC_DIR, filePath);
    // Ensure we don't escape PUBLIC_DIR
    if (!fullPath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    serveStatic(res, fullPath);
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
});

// ─── Event normalization ─────────────────────────────────────────────────────

function normalizeEvent(raw: Record<string, unknown>): ObserverEvent {
  eventIdCounter += 1;
  const id = eventIdCounter;
  const time = (raw.time as string) ?? new Date().toISOString();
  const type = (raw.type as ObserverEvent['type']) ?? 'model_note';
  const phase = (raw.phase as ObserverEvent['phase']) ?? 'thinking';

  const event: ObserverEvent = {
    id,
    time,
    type,
    phase,
  };

  if (raw.text) event.text = raw.text as string;
  if (raw.contextUsedTokens != null) event.contextUsedTokens = raw.contextUsedTokens as number;
  if (raw.contextWindowTokens != null) event.contextWindowTokens = raw.contextWindowTokens as number;
  if (raw.modelId) event.modelId = raw.modelId as string;
  if (raw.providerName) event.providerName = raw.providerName as string;

  // Tool call enrichment with suspicious-tool heuristics
  if (
    type === 'tool_call_started' ||
    type === 'tool_call_finished' ||
    type === 'tool_call_failed'
  ) {
    const toolName = (raw.toolName as string) ?? (raw.tool?.name as string) ?? 'unknown';
    const toolArgs = (raw.arguments as Record<string, unknown>) ?? (raw.tool?.arguments as Record<string, unknown>) ?? {};
    const severityResult = analyzeToolCall({ toolName, arguments: toolArgs });

    event.tool = {
      name: toolName,
      summary: (raw.summary as string) ?? (raw.tool?.summary as string) ?? toolName,
      status:
        type === 'tool_call_started'
          ? 'running'
          : type === 'tool_call_failed'
            ? 'failed'
            : 'completed',
      severity: severityResult.severity,
      reasons: severityResult.reasons.length > 0 ? severityResult.reasons : undefined,
      timestamp: time,
    };
    event.severity = severityResult.severity;
  }

  return event;
}

// ─── Main ────────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log(`[shoggoth-observer] listening on http://${HOST}:${PORT}`);
  console.log(`[shoggoth-observer] SSE endpoint:  http://${HOST}:${PORT}/events`);
  console.log(`[shoggoth-observer] ingest endpoint: POST http://${HOST}:${PORT}/ingest`);
  console.log(`[shoggoth-observer] Open http://${HOST}:${PORT} to watch the shoggoth.`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[shoggoth-observer] shutting down');
  for (const client of sseClients) {
    client.end();
  }
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  for (const client of sseClients) {
    client.end();
  }
  server.close(() => process.exit(0));
});
