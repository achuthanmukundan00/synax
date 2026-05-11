/**
 * Telemetry Bridge — CommonJS runtime for Synax → Shoggoth Observer.
 *
 * Compiled counterpart of telemetry-bridge.ts. Loaded via require() from
 * dist/commands/chat.js (and tsx-run scripts like super.ts).
 *
 * POSTs batched events to the observer server's /ingest endpoint.
 * Safe if no observer server is running — fetch errors are silently swallowed.
 *
 * V2: Enhanced with rich event data (tool args, shell commands, file paths,
 * risk scoring) for the full Shoggoth Observer morphology viewer.
 */

const OBSERVER_INGEST_URL = 'http://127.0.0.1:8559/ingest';

let bridgeEnabled = false;
let bridgeModelId = '';
let bridgeProviderName = '';
let pendingEvents = [];
let flushTimer = null;
const FLUSH_INTERVAL_MS = 200;

// ─── Shell risk patterns ─────────────────────────────────────────────────

const HIGH_RISK_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bcurl\s+.*\|\s*(ba)?sh\b/i,
  /\bsudo\b/i,
  /\bchmod\s+.*777\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bgit\s+push\s+-f\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\./i,
  /\b:(){ :|:& };:/,
  />\s*\/dev\/sd[a-z]/i,
];

const MEDIUM_RISK_PATTERNS = [
  /\bchmod\s+-R\b/i,
  /\bchown\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnc\b/i,
  /\bssh\b(?!\s+-[tT])/i,
  /\bnpm\s+(i|install)\s+-g\b/i,
  /\bpip\s+install\b/i,
  /\bdocker\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bgit\s+remote\s+(add|set-url)\b/i,
  /\bbrew\s+install\b/i,
  /\bapt-get\b/i,
  /\bscp\b/i,
];

function scoreShellRisk(command) {
  for (var i = 0; i < HIGH_RISK_PATTERNS.length; i++) {
    if (HIGH_RISK_PATTERNS[i].test(command)) return { risk: 'high', reasons: [String(HIGH_RISK_PATTERNS[i])] };
  }
  for (var j = 0; j < MEDIUM_RISK_PATTERNS.length; j++) {
    if (MEDIUM_RISK_PATTERNS[j].test(command)) return { risk: 'medium', reasons: [String(MEDIUM_RISK_PATTERNS[j])] };
  }
  return { risk: 'low', reasons: [] };
}

function scoreToolRisk(toolName, args) {
  if (toolName === 'bash' || toolName === 'shell') {
    var cmd = (args && (args.command || args.cmd || args.cmdline)) || '';
    if (typeof cmd === 'string' && cmd.trim()) return scoreShellRisk(cmd).risk;
  }
  var path = (args && (args.path || args.filepath || args.file || args.target)) || '';
  if (typeof path === 'string') {
    if (/\/etc\/|\/private\/|\.ssh\/|\.aws\/|\.config\/hub|\.git\/config/.test(path)) return 'high';
    if (/\.env|\.secrets?|credentials|\.pem|\.key/.test(path)) return 'medium';
  }
  return 'low';
}

// ─── API ──────────────────────────────────────────────────────────────────

function initTelemetryBridge(options) {
  var opts = options || {};
  bridgeEnabled = opts.enabled !== false;
  bridgeModelId = opts.modelId || '';
  bridgeProviderName = opts.providerName || '';
}

function pushObserverEvent(event) {
  if (!bridgeEnabled) return;
  if (!event.time) event.time = new Date().toISOString();
  if (bridgeModelId && !event.modelId) event.modelId = bridgeModelId;
  if (bridgeProviderName && !event.providerName) event.providerName = bridgeProviderName;
  pendingEvents.push(event);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(function () {
    flushTimer = null;
    flushNow();
  }, FLUSH_INTERVAL_MS);
}

function flushNow() {
  if (pendingEvents.length === 0) return;
  var batch = pendingEvents;
  pendingEvents = [];

  fetch(OBSERVER_INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  }).catch(function () {
    // Observer server not running — silently ignore
  });
}

function shutdownTelemetryBridge() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushNow();
  bridgeEnabled = false;
}

/**
 * Create an event sink function compatible with chat.ts setEventSink.
 * Wraps raw Synax AgentEvents into rich bridge events with tool args,
 * shell commands, file paths, and risk scoring.
 */
function createObserverEventSink() {
  return function (synaxEvent) {
    var bridgeEvent = {
      type: synaxEvent.type,
      time: synaxEvent.timestamp || new Date().toISOString(),
    };

    switch (synaxEvent.type) {
      case 'task_started':
        bridgeEvent.type = 'session_started';
        bridgeEvent.modelId = synaxEvent.model;
        bridgeModelId = synaxEvent.model || bridgeModelId;
        bridgeEvent.providerName = synaxEvent.providerName;
        bridgeProviderName = synaxEvent.providerName || bridgeProviderName;
        bridgeEvent.text = 'Session started: ' + (synaxEvent.task || '');
        bridgeEvent.phase = 'idle';
        break;

      case 'assistant_message':
        bridgeEvent.type = 'model_note';
        bridgeEvent.text = synaxEvent.content;
        bridgeEvent.phase = 'thinking';
        break;

      case 'assistant_delta':
        bridgeEvent.type = 'assistant_delta';
        var deltaText = [synaxEvent.reasoningContent, synaxEvent.content].filter(Boolean).join('');
        bridgeEvent.text = deltaText || undefined;
        bridgeEvent.phase = 'streaming';
        break;

      case 'model_step_started':
        bridgeEvent.type = 'model_note';
        bridgeEvent.text = 'model step started';
        bridgeEvent.phase = 'thinking';
        break;

      case 'tool_started':
        bridgeEvent.type = 'tool_call_started';
        var toolName = synaxEvent.toolName || 'unknown';
        var summary = synaxEvent.summary;
        var detail = synaxEvent.detail;
        var argsPreview = summary || detail || '';
        var args = synaxEvent.arguments || {};
        var risk = scoreToolRisk(toolName, args);

        // Extract command for shell tools
        if (toolName === 'bash' || toolName === 'shell') {
          var cmd = (args.command || args.cmd || args.cmdline || '');
          if (typeof cmd === 'string' && cmd.trim()) {
            bridgeEvent.command = cmd;
            var shellScore = scoreShellRisk(cmd);
            bridgeEvent.risk = shellScore.risk;
          }
        }

        // Extract file path for read/write/edit
        var path = (args.path || args.filepath || args.file || args.target || '');
        if (typeof path === 'string' && path.trim()) bridgeEvent.path = path;

        bridgeEvent.tool = {
          name: toolName,
          summary: argsPreview,
          status: 'running',
          arguments: args,
          argsPreview: argsPreview,
        };
        bridgeEvent.phase = 'tool_running';
        if (!bridgeEvent.risk) bridgeEvent.risk = risk;
        break;

      case 'tool_finished':
        var toolName2 = synaxEvent.toolName || 'unknown';
        var summary2 = synaxEvent.summary;
        var status = synaxEvent.status;
        var detail2 = synaxEvent.detail;
        bridgeEvent.type = status === 'ok' ? 'tool_call_finished' : 'tool_call_failed';
        bridgeEvent.tool = {
          name: toolName2,
          summary: summary2 || detail2 || toolName2,
          status: status === 'ok' ? 'completed' : 'failed',
          arguments: {},
        };
        if (synaxEvent.exitCode != null) bridgeEvent.exitCode = synaxEvent.exitCode;
        bridgeEvent.phase = 'thinking';
        break;

      case 'context_budget_updated':
        bridgeEvent.type = 'budget_update';
        bridgeEvent.contextUsedTokens = synaxEvent.estimatedInputTokens;
        bridgeEvent.contextWindowTokens = synaxEvent.contextWindowTokens;
        bridgeEvent.phase = 'thinking';
        break;

      case 'task_finished':
        bridgeEvent.type = 'session_finished';
        var taskStatus = synaxEvent.status;
        bridgeEvent.text = 'Session finished: ' + taskStatus;
        bridgeEvent.phase = taskStatus === 'completed' ? 'completed' : 'error';
        break;

      case 'error':
        bridgeEvent.type = 'error';
        bridgeEvent.text = synaxEvent.message;
        bridgeEvent.phase = 'error';
        break;

      default:
        break;
    }

    pushObserverEvent(bridgeEvent);
  };
}

module.exports = {
  initTelemetryBridge: initTelemetryBridge,
  pushObserverEvent: pushObserverEvent,
  createObserverEventSink: createObserverEventSink,
  shutdownTelemetryBridge: shutdownTelemetryBridge,
};
