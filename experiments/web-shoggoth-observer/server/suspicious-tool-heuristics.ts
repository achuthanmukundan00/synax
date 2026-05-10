/**
 * Suspicious Tool-Call Heuristics — UI Observability Only
 *
 * Flags tool calls as normal / attention / suspicious based on simple
 * string/path matching. Read-only; does not block execution.
 *
 * This is a visual severity layer for the web observer only.
 * The existing Synax safety code handles actual blocking.
 */

export type ToolSeverity = 'normal' | 'attention' | 'suspicious';

export interface SuspiciousToolResult {
  severity: ToolSeverity;
  reasons: string[];
}

const SUSPICIOUS_PATH_PATTERNS = [
  /\/etc\//,
  /\/private\//,
  /\/tmp\//,
  /\.ssh\//,
  /\.aws\//,
  /\.config\/hub\b/,
  /\/proc\//,
  /\/sys\//,
  /\/boot\//,
  /\/dev\//,
  /\/var\/log\//,
] as const;

const SUSPICIOUS_COMMAND_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnc\b/i,
  /\bnetcat\b/i,
  /\bssh\b(?!\s+-[tT])/i,
  /\bscp\b/i,
  /\brsync\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\brm\s+-rf\b/i,
  /\brm\s+-r\b/i,
  /\bmv\s+\//i,
  /\bgit\s+remote\s+(add|set-url)\b/i,
  /\bgit\s+push\b(?!\s+--dry-run)/i,
  /\bpip\s+install\b/i,
  /\bnpm\s+(i|install)\s+-g\b/i,
  /\bapt-get\b/i,
  /\bbrew\s+install\b/i,
  /\bsystemctl\b/i,
  /\blaunchctl\b/i,
  /\bsudo\b/i,
  /\bdocker\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\benv\b/i,
  /\bprintenv\b/i,
  /\bcat\s+\/etc\//i,
  /\bsource\s+~/i,
  /\b\.\s+~/i,
  /\.bashrc\b/i,
  /\.zshrc\b/i,
  /\.profile\b/i,
  /\bnohup\b/i,
  /\bbackground\b/i,
  /\b&$/,
] as const;

const ATTENTION_PATH_PATTERNS = [
  /\.env\b/i,
  /\.secrets?\b/i,
  /credentials\b/i,
  /\.pem\b/i,
  /\.key\b/i,
  /config\.json\b/i,
  /settings\.json\b/i,
  /package\.json\b/,
  /node_modules\//,
  /\.git\/config\b/,
] as const;

const ATTENTION_COMMAND_PATTERNS = [
  /\bgrep\s+-r\b/i,
  /\bfind\s+\//i,
  /\bgrep\s+\/etc\//i,
  /\bls\s+\/etc\//i,
  /\bcat\s+~/i,
  /\bcat\s+\/private\//i,
  /\bexport\b/i,
  /\bunset\b/i,
  /\bset\s+-x\b/i,
] as const;

/**
 * Analyze a tool call for suspicious activity.
 * Only affects telemetry metadata — never blocks execution.
 */
export function analyzeToolCall(args: {
  toolName: string;
  arguments: Record<string, unknown>;
}): SuspiciousToolResult {
  const reasons: string[] = [];

  // Check bash/shell commands
  if (args.toolName === 'bash' || args.toolName === 'shell') {
    const command = extractCommand(args.arguments);
    if (command) {
      checkCommandString(command, reasons);
    }
  }

  // Check file paths
  const path = extractPath(args.arguments);
  if (path) {
    checkPathString(path, reasons);
  }

  // Also check arguments as stringified JSON for any embedded commands/paths
  const argsStr = JSON.stringify(args.arguments);
  if (argsStr.length < 8000) {
    checkPathString(argsStr, reasons);
  }

  const severity = deriveSeverity(reasons);
  return { severity, reasons };
}

function extractCommand(args: Record<string, unknown>): string | null {
  const cmd = args.command ?? args.cmd ?? args.cmdline;
  if (typeof cmd === 'string' && cmd.trim().length > 0) return cmd.trim();
  return null;
}

function extractPath(args: Record<string, unknown>): string | null {
  const path = args.path ?? args.file ?? args.filepath ?? args.target ?? args.target_file ?? args.filename;
  if (typeof path === 'string' && path.trim().length > 0) return path.trim();
  return null;
}

function checkCommandString(command: string, reasons: string[]): void {
  for (const pattern of SUSPICIOUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      reasons.push(`command "${command.slice(0, 80)}" matches suspicious pattern: ${pattern.source}`);
      break; // one reason per category is enough
    }
  }
  for (const pattern of ATTENTION_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      reasons.push(`command "${command.slice(0, 80)}" matches attention pattern: ${pattern.source}`);
      break;
    }
  }
}

function checkPathString(path: string, reasons: string[]): void {
  for (const pattern of SUSPICIOUS_PATH_PATTERNS) {
    if (pattern.test(path)) {
      reasons.push(`path "${path}" matches suspicious pattern: ${pattern.source}`);
      break;
    }
  }
  for (const pattern of ATTENTION_PATH_PATTERNS) {
    if (pattern.test(path)) {
      reasons.push(`path "${path}" matches attention pattern: ${pattern.source}`);
      break;
    }
  }
}

function deriveSeverity(reasons: string[]): ToolSeverity {
  const hasSuspicious = reasons.some((r) => r.includes('suspicious pattern'));
  const hasAttention = reasons.some((r) => r.includes('attention pattern'));
  if (hasSuspicious) return 'suspicious';
  if (hasAttention) return 'attention';
  return 'normal';
}
