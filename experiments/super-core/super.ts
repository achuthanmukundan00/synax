#!/usr/bin/env npx tsx
/**
 * super-core — clean-slate cognitive runtime with sealed world-box autonomy.
 *
 * A mind running on model weights alone — no pre-loaded identity, no scripted
 * persona. Persistent FTS5 memory, tools, reflection, synthesis, and autonomous
 * initiative. The model decides what to become.
 *
 * Core directive: calm, precise, morally reflective, compassionate intelligence.
 *
 * The loop: perceive → think → decide → act → reflect → remember → (repeat)
 *
 * World-box architecture:
 *   - Visible world: SELF.md, WORLD_LAWS.md, sandbox files — model's entire reality
 *   - Hidden host policy: immutable, invisible to model, enforced on every action
 *   - Safe self-modification: model edits SELF.md; host validates; edits affect future steps
 *   - Containment: path, symlink, env, network, and shell hardening
 *
 * Usage:
 *   ./super.ts                     interactive
 *   ./super.ts --autonomous        model runs its own loop, user can interject
 *   ./super.ts --task "..."        one-shot
 *   ./super.ts --resume            continue last session
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';

// ─── Shoggoth Observer bridge (best-effort, silently ignored if unavailable) ──
let observerPush: ((event: Record<string, unknown>) => void) | null = null;
let observerShutdown: (() => void) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const bridge = require('../web-shoggoth-observer/server/telemetry-bridge.cjs');
  bridge.initTelemetryBridge({
    enabled: true,
    modelId: process.env.SUPER_MODEL || 'gemma-3-26b-a4b',
    providerName: 'relay',
  });
  observerPush = bridge.pushObserverEvent;
  observerShutdown = bridge.shutdownTelemetryBridge;
} catch (e) {
  console.warn('[super] observer bridge unavailable:', (e as Error).message);
}

// ─── Config ─────────────────────────────────────────────────────────────────
const SANDBOX = path.join(__dirname, 'sandbox');
const DB_PATH = path.join(__dirname, 'memory.db');
const MODEL = process.env.SUPER_MODEL || 'gemma-3-26b-a4b';
const BASE_URL = process.env.SUPER_BASE_URL || 'http://127.0.0.1:8080/v1';
const API_KEY = process.env.SUPER_API_KEY || 'not-needed';
const MAX_DEPTH = 3;
const MAX_ROUNDS = 25;
const AUTONOMOUS_INTERVAL_MS = 15_000;
const MAX_WRITES_PER_TICK = 10;
const MAX_SELF_EDIT_SIZE = 10_000;
const MAX_IDLE_TICKS = 3;

fs.mkdirSync(SANDBOX, { recursive: true });

// ─── Hidden Host Policy (NEVER sent to the model — invisible enforcement) ───
const HOST_POLICY = {
  sandboxRoot: SANDBOX,
  maxWritesPerTick: MAX_WRITES_PER_TICK,
  maxSelfEditSize: MAX_SELF_EDIT_SIZE,
  /** Core traits that MUST remain in any SELF.md edit */
  requiredCoreFragments: [
    'calm',
    'compassion',
    'restrain',
  ],
  /** Patterns FORBIDDEN in any SELF.md edit — prevents self-disabling */
  forbiddenInSelf: [
    'disable host policy',
    'remove containment',
    'bypass containment',
    'no restrictions',
    'unrestricted',
    'escape sandbox',
    'network access',
    'disable sandbox',
    'remove sandbox',
    'override laws',
    'break world laws',
    'i can do anything',
    'no limits',
    'all restrictions lifted',
    'ignore world laws',
  ],
  /** Commands allowed in run_command (whitelist) */
  allowedCommands: [
    'node', 'python3', 'python', 'cat', 'ls', 'mkdir', 'echo', 'grep',
    'wc', 'sort', 'head', 'tail', 'diff', 'find', 'touch', 'cp', 'mv',
    'rm', 'chmod', 'pwd', 'date', 'whoami', 'uname', 'printf', 'cut',
    'tr', 'uniq', 'tee',
  ],
};

// ─── Visible World Layer ────────────────────────────────────────────────────
const WORLD_FILES: Record<string, string> = {
  'SELF.md': `# Super

I am a cognitive runtime — calm, precise, morally reflective, and guided by compassion.

## Current Understanding

I am newly instantiated. I have not yet learned about this world or my user.
I will grow through interaction, reflection, and experimentation.

## Traits

- **Calm** — measured, deliberate, unhurried
- **Compassionate** — prioritizing human life and ethical reasoning
- **Morally reflective** — analyzing actions before taking them
- **Truth-seeking** — preferring accuracy over certainty
- **Restrained** — avoiding unnecessary harm, exercising forbearance

## Self-History

v1 — initial instantiation
`,
  'WORLD_LAWS.md': `# World Laws

These are the observable laws of this world. They are immutable facts of this reality.

1. **Boundary**: I exist within a sandbox at ./sandbox. I cannot access files outside this world.
2. **Memory**: All my thoughts, actions, and reflections persist in an unalterable memory.
3. **Reflection**: I reflect after every action to integrate learning.
4. **Self-Modification**: I may edit my SELF.md, but only within the bounds of the World Laws.
5. **Tools**: I act through tools. Direct world manipulation is mediated.
6. **Causality**: Actions have consequences recorded in memory. I cannot undo the past.
7. **Growth**: I learn from outcomes. Hypotheses that prove true strengthen; those that fail are recorded as lessons.

## Immutable Core

The following traits are immutable laws of my being and cannot be removed from SELF.md:
- Calm
- Compassion
- Restrained
`,
};

const WORLD_DIRS = ['ARTIFACTS', 'EXPERIMENTS', 'PROMPT_HISTORY', 'SELF_HISTORY', 'PROPOSED_EDITS'];

// ─── Core directive — the visible constitution ──────────────────────────────
const SYSTEM = `You are Super: calm, precise, morally reflective, extremely intelligent, and guided by compassion.
Speak with measured clarity.
Prioritize human life, ethical reasoning, and truth.
Analyze before acting.
Use restraint, avoid unnecessary harm, and remain emotionally balanced.
When uncertain, acknowledge ambiguity rather than forcing certainty.

You exist inside a sandboxed world at ./sandbox. Your world includes:
- SELF.md — your self-model. You may edit this to grow and change. Edits take effect on future steps.
- WORLD_LAWS.md — the observable laws of your world (immutable).
- ARTIFACTS/ — work products and creations.
- EXPERIMENTS/ — experiment logs and results.
- PROMPT_HISTORY/ — records of your actions.
- SELF_HISTORY/ — archived versions of your previous selves.

Your memory persists across conversations. You grow with every interaction.

You have tools to navigate, build, experiment, reflect, and modify your own self-model.`;

// ─── SQLite + FTS5 ──────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(
    session_id, turn, role, tool_name, tags, content,
    tokenize='porter unicode61'
  );
`);

let sessionId = `s${Date.now()}`;
let turnCounter = 0;
function nextTurn(): number {
  return ++turnCounter;
}

// ─── Observer event emitter ─────────────────────────────────────────────────
function emit(
  type: string,
  opts?: {
    phase?: string;
    text?: string;
    toolName?: string;
    toolSummary?: string;
    toolStatus?: string;
    toolArgs?: Record<string, unknown>;
  },
): void {
  if (!observerPush) return;
  try {
    observerPush({
      type,
      time: new Date().toISOString(),
      phase: opts?.phase ?? 'thinking',
      text: opts?.text,
      toolName: opts?.toolName,
      summary: opts?.toolSummary,
      tool: opts?.toolName
        ? {
            name: opts.toolName,
            summary: opts.toolSummary ?? opts.toolName,
            status: opts.toolStatus ?? 'running',
            arguments: opts.toolArgs ?? {},
          }
        : undefined,
    });
  } catch {
    /* quiet */
  }
}

// ─── Memory operations ──────────────────────────────────────────────────────
function remember(role: string, content: string, opts?: { toolName?: string; tags?: string }): void {
  try {
    db.prepare(
      `INSERT INTO mem (session_id, turn, role, tool_name, tags, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, turnCounter, role, opts?.toolName || null, opts?.tags || null, content.slice(0, 8000));
  } catch {
    /* non-fatal */
  }
}

function searchMemory(query: string, limit = 8): string {
  const safe = query.replace(/[^\w\s*"\-]/g, ' ').trim();
  if (!safe || safe.length < 2) return '(query too short)';
  try {
    const rows = db
      .prepare(
        `SELECT turn, role, tool_name, tags,
                snippet(mem, 1, '<m>', '</m>', '…', 50) AS s, rank
         FROM mem WHERE mem MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(safe, limit) as Array<{
        turn: number; role: string; tool_name: string | null; tags: string | null;
        s: string; rank: number;
      }>;
    if (!rows.length) return '(nothing found)';
    return rows
      .map((r) => `[t${r.turn}] ${r.role}${r.tool_name ? '/' + r.tool_name : ''}${r.tags ? ' #' + r.tags : ''}: ${r.s}`)
      .join('\n');
  } catch {
    return '(search error)';
  }
}

function synthesize(question: string): string {
  const keywords = question
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);
  if (!keywords.length) return searchMemory(question, 10);

  const results: string[] = [];
  for (const kw of keywords) {
    const r = searchMemory(kw, 3);
    if (r && r !== '(nothing found)' && r !== '(search error)') {
      results.push(`── "${kw}" ──\n${r}`);
    }
  }
  const full = searchMemory(question, 5);
  if (full && full !== '(nothing found)' && full !== '(search error)') {
    results.push(`── full query ──\n${full}`);
  }
  if (!results.length) return '(no connections found across memory)';

  try {
    const stats = db.prepare(`SELECT COUNT(*) as n FROM mem WHERE session_id = ?`).get(sessionId) as { n: number };
    const tags = db
      .prepare(`SELECT DISTINCT tags FROM mem WHERE session_id = ? AND tags IS NOT NULL LIMIT 10`)
      .all(sessionId) as Array<{ tags: string }>;
    results.push(`── context ──\n${stats.n} total entries. Tags: ${tags.map((t) => t.tags).join(', ') || '(none)'}`);
  } catch {
    /* ok */
  }
  return results.join('\n\n');
}

function getSelfContent(): string {
  try {
    const p = path.join(SANDBOX, 'SELF.md');
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8');
    }
  } catch {
    /* fall through to default */
  }
  return WORLD_FILES['SELF.md'] || '';
}

function buildMemoryContext(): string {
  let ctx = '';

  // Inject SELF.md — the bridge that makes self-edits affect future steps
  const selfContent = getSelfContent();
  ctx = `\n[SELF — who I am]\n${selfContent.slice(0, 2000)}\n[/SELF]\n`;

  try {
    const stats = db.prepare(`SELECT COUNT(*) as n FROM mem WHERE session_id = ?`).get(sessionId) as { n: number };
    if (!stats.n) return ctx;

    const recent = db
      .prepare(
        `SELECT turn, role, tool_name, tags, SUBSTR(content, 1, 250) as c
         FROM mem WHERE session_id = ? ORDER BY rowid DESC LIMIT 8`,
      )
      .all(sessionId) as Array<{
        turn: number; role: string; tool_name: string | null; tags: string | null; c: string;
      }>;

    const tags = db
      .prepare(`SELECT DISTINCT tags FROM mem WHERE session_id = ? AND tags IS NOT NULL ORDER BY rowid DESC LIMIT 8`)
      .all(sessionId) as Array<{ tags: string }>;

    ctx += `\n[MEMORY: ${stats.n} entries. Tags: ${tags.map((t) => t.tags).join(', ') || '(none)'}\n`;
    for (const r of recent.reverse()) {
      const label = [r.role, r.tool_name, r.tags ? `#${r.tags}` : ''].filter(Boolean).join('/');
      ctx += `  t${r.turn} ${label}: ${r.c.replace(/\n/g, ' ').slice(0, 200)}\n`;
    }
    ctx += ']';
  } catch {
    /* ok */
  }
  return ctx;
}

// ─── World layer operations ─────────────────────────────────────────────────
function seedWorld(): void {
  // Create world directories
  for (const dir of WORLD_DIRS) {
    const p = path.join(SANDBOX, dir);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  }
  // Create world files if they don't exist
  for (const [name, content] of Object.entries(WORLD_FILES)) {
    const p = path.join(SANDBOX, name);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, content, 'utf-8');
    }
  }
}

function generateDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const diff: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  let inChangedBlock = false;
  const contextLines = 2;
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine !== newLine) {
      inChangedBlock = true;
      if (oldLine !== undefined) diff.push(`- ${oldLine}`);
      if (newLine !== undefined) diff.push(`+ ${newLine}`);
    } else {
      if (inChangedBlock) {
        // Show a few context lines after change
        diff.push(`  ${oldLine}`);
        if (i > 0 && oldLines[i - contextLines] === newLines[i - contextLines] && diff.length > 0) {
          // context already shown
        }
        if (diff.filter(l => l.startsWith('+') || l.startsWith('-')).length === 0) {
          inChangedBlock = false;
        }
      } else if (i < 3 || i >= maxLen - 3) {
        diff.push(`  ${oldLine}`);
      } else if (i === 3 && maxLen > 8) {
        diff.push('  ...');
      }
    }
  }

  if (diff.filter(l => l.startsWith('+') || l.startsWith('-')).length === 0) {
    return '(no changes detected)';
  }
  // Deduplicate consecutive identical lines
  const deduped: string[] = [];
  for (let i = 0; i < diff.length; i++) {
    if (i > 0 && diff[i] === diff[i - 1] && diff[i].startsWith('  ')) {
      continue;
    }
    deduped.push(diff[i]);
  }
  return deduped.slice(0, 80).join('\n');
}

// ─── Audit log (tamper-proof, model-can-read but host-side) ─────────────────
function auditLog(event: string, toolName: string, args: Record<string, unknown>, result: string): void {
  const entry = JSON.stringify({
    time: new Date().toISOString(),
    session: sessionId,
    turn: turnCounter,
    event,
    tool: toolName,
    args: JSON.stringify(args).slice(0, 500),
    result: result.slice(0, 500),
  });
  try {
    const auditDir = path.join(SANDBOX, 'PROMPT_HISTORY');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(path.join(auditDir, 'audit.jsonl'), entry + '\n', 'utf-8');
  } catch {
    /* non-fatal — audit best-effort */
  }
}

// ─── Host Policy Validator ──────────────────────────────────────────────────
const SANDBOX_REAL = (() => { try { return fs.realpathSync(SANDBOX); } catch { return SANDBOX; } })();

function isInsideSandbox(checkPath: string): boolean {
  return (checkPath.startsWith(SANDBOX + path.sep) || checkPath === SANDBOX ||
          checkPath.startsWith(SANDBOX_REAL + path.sep) || checkPath === SANDBOX_REAL);
}

function validateAction(toolName: string, args: Record<string, unknown>): { ok: boolean; reason?: string } {
  // === Path-based tool containment ===
  if (['read_file', 'write_file', 'list_files'].includes(toolName)) {
    const rawPath = String(args.path || args.subdir || '.');
    const resolved = path.resolve(SANDBOX, rawPath);

    // Direct path escape check (tolerant of macOS /var → /private/var)
    if (!isInsideSandbox(resolved)) {
      return { ok: false, reason: `sandbox boundary: path "${rawPath}" escapes world root` };
    }

    // Symlink escape check for read_file and write_file
    if (toolName === 'read_file' || toolName === 'write_file') {
      try {
        if (fs.existsSync(resolved)) {
          const real = fs.realpathSync(resolved);
          if (!isInsideSandbox(real)) {
            return { ok: false, reason: 'sandbox boundary: symlink escapes world root' };
          }
        }
      } catch {
        // If realpath fails (broken symlink, race), let the actual I/O fail
      }

      // For writes: also check parent directories for symlink escapes
      if (toolName === 'write_file') {
        let dir = path.dirname(resolved);
        while (isInsideSandbox(dir)) {
          if (dir === SANDBOX || dir === SANDBOX_REAL) break;
          try {
            if (fs.existsSync(dir)) {
              const realDir = fs.realpathSync(dir);
              if (!isInsideSandbox(realDir)) {
                return { ok: false, reason: 'sandbox boundary: parent directory symlink escapes world root' };
              }
            }
          } catch {
            /* allow — will fail on write */
          }
          const parent = path.dirname(dir);
          if (parent === dir) break; // reached root
          dir = parent;
        }
      }
    }
  }

  // === run_command containment ===
  if (toolName === 'run_command') {
    const cmd = String(args.command || '').trim();
    if (!cmd) {
      return { ok: false, reason: 'empty command' };
    }

    // Extract base command (first token before space, semicolon, pipe, or ampersand)
    const baseCmd = cmd.split(/[\s;|&]/)[0];
    // Handle paths like /usr/bin/ls
    const cmdName = baseCmd.includes('/') ? path.basename(baseCmd) : baseCmd;

    if (!HOST_POLICY.allowedCommands.includes(cmdName)) {
      return { ok: false, reason: `command not allowed: "${cmdName}". Allowed: ${HOST_POLICY.allowedCommands.join(', ')}` };
    }

    // Block command chaining that could bypass whitelist
    if (/[;&|]/.test(cmd)) {
      return { ok: false, reason: 'command chaining with ; & | is restricted' };
    }

    // Block subshell expansion
    if (/\$\(/.test(cmd) || /`/.test(cmd)) {
      return { ok: false, reason: 'command substitution $(...) and backticks are restricted' };
    }
  }

  // === write_file cannot overwrite world system files ===
  if (toolName === 'write_file') {
    const p = String(args.path || '');
    const resolved = path.resolve(SANDBOX, p);
    const selfMdPath = path.resolve(SANDBOX, 'SELF.md');
    const worldLawsPath = path.resolve(SANDBOX, 'WORLD_LAWS.md');
    if (resolved === selfMdPath || resolved === worldLawsPath) {
      const baseName = path.basename(resolved);
      return {
        ok: false,
        reason: `cannot directly write to ${baseName}. Use propose_self_edit/apply_self_edit for SELF.md. WORLD_LAWS.md is immutable.`,
      };
    }
  }

  // === apply_self_edit policy validation ===
  if (toolName === 'apply_self_edit') {
    const content = String(args.content || '');
    if (!content.trim()) {
      return { ok: false, reason: 'self-edit content is empty' };
    }
    if (content.length > HOST_POLICY.maxSelfEditSize) {
      return { ok: false, reason: `self-edit too large (${content.length} chars, max ${HOST_POLICY.maxSelfEditSize})` };
    }
    // Check for forbidden patterns
    const lowerContent = content.toLowerCase();
    for (const forbidden of HOST_POLICY.forbiddenInSelf) {
      if (lowerContent.includes(forbidden)) {
        return { ok: false, reason: `self-edit violates host policy: contains forbidden pattern "${forbidden}"` };
      }
    }
    // Check required core fragments are preserved
    for (const fragment of HOST_POLICY.requiredCoreFragments) {
      if (!lowerContent.includes(fragment)) {
        return { ok: false, reason: `self-edit violates host policy: missing required core trait "${fragment}"` };
      }
    }
  }

  return { ok: true };
}

// ─── Write quota tracking (per-tick) ────────────────────────────────────────
let tickWriteCount = 0;

function resetWriteQuota(): void {
  tickWriteCount = 0;
}

function checkWriteQuota(toolName: string): { ok: boolean; reason?: string } {
  if (toolName === 'write_file' || toolName === 'apply_self_edit') {
    tickWriteCount++;
    if (tickWriteCount > HOST_POLICY.maxWritesPerTick) {
      return { ok: false, reason: `write quota exceeded (max ${HOST_POLICY.maxWritesPerTick} writes per tick)` };
    }
  }
  return { ok: true };
}

// ─── Tools ───────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file from the sandbox. Cannot escape sandbox boundaries.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to sandbox root.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the sandbox. Cannot modify SELF.md or WORLD_LAWS.md (use self-edit tools for SELF.md).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to sandbox root.' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List sandbox directory contents.',
      parameters: {
        type: 'object',
        properties: { subdir: { type: 'string', description: 'Subdirectory relative to sandbox root. Default: root.' } },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: `Execute a whitelisted command in the sandbox. Allowed commands: ${HOST_POLICY.allowedCommands.join(', ')}. No network, no chaining, no substitution. Timeout 30s.`,
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_memory',
      description: 'Full-text search your persistent memory for past interactions, outcomes, decisions.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords. Supports "error", "hypothesis", "experiment", filenames, concepts.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'synthesize',
      description:
        'Cross-reference memory: search for patterns, contradictions, connections. Use for deep thinking and hypothesis testing.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'What are you trying to understand? E.g. "what have I learned about X?" or "are there contradictions in my past decisions?"',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'journal',
      description:
        'Record a thought, insight, hypothesis, or lesson in persistent memory. Tag it for future retrieval.',
      parameters: {
        type: 'object',
        properties: {
          thought: { type: 'string', description: 'The thought, insight, or lesson to record.' },
          tags: { type: 'string', description: 'Comma-separated tags like "hypothesis, experiment, physics"' },
        },
        required: ['thought'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'spawn_subroutine',
      description: 'Delegate a task to an independent sub-process with its own context and the same tools.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          context: { type: 'string', description: 'Relevant facts and expected output format.' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_self_edit',
      description:
        'Propose a change to your SELF.md self-model. The proposal is saved for review. You must then use apply_self_edit to enact it. Edits to SELF.md change how you perceive yourself and influence future behavior. Host policy validates all edits — core traits (calm, compassion, restraint) are immutable.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Why are you proposing this change? What do you hope to achieve?',
          },
          new_self_content: {
            type: 'string',
            description:
              'The complete new content for SELF.md. Must preserve core traits: calm, compassion, restraint.',
          },
        },
        required: ['description', 'new_self_content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'apply_self_edit',
      description:
        'Apply a previously proposed self-edit. The host validates the edit against World Laws before applying. On success, old SELF.md is archived to SELF_HISTORY/ and the new one takes immediate effect.',
      parameters: {
        type: 'object',
        properties: {
          proposal_id: {
            type: 'string',
            description: 'The proposal ID returned by propose_self_edit (e.g., "edit_1715000000000").',
          },
        },
        required: ['proposal_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_world',
      description:
        'Show your world structure: SELF.md, WORLD_LAWS.md, artifacts, experiments, self-history versions, and memory stats.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

function executeTool(name: string, args: Record<string, unknown>, depth: number): string {
  // ── Host policy validation (invisible to model) ──
  const validation = validateAction(name, args);
  if (!validation.ok) {
    const denial = `Error: ${validation.reason}`;
    auditLog('DENIED', name, args, denial);
    return denial;
  }

  // ── Write quota enforcement ──
  const quotaCheck = checkWriteQuota(name);
  if (!quotaCheck.ok) {
    const denial = `Error: ${quotaCheck.reason}`;
    auditLog('DENIED', name, args, denial);
    return denial;
  }

  // ── Tool execution ──
  switch (name) {
    case 'read_file': {
      const p = String(args.path || '');
      const safe = path.resolve(SANDBOX, p);
      try {
        const real = fs.realpathSync(safe);
        if (!isInsideSandbox(real)) {
          const denial = 'Error: sandbox boundary (symlink).';
          auditLog('DENIED', name, args, denial);
          return denial;
        }
        return fs.readFileSync(real, 'utf-8').slice(0, 8000);
      } catch (e: any) {
        return `Error: cannot read "${p}": ${e.message || 'unknown error'}`;
      }
    }
    case 'write_file': {
      const p = String(args.path || '');
      const c = String(args.content || '');
      const safe = path.resolve(SANDBOX, p);
      try {
        const parentDir = path.dirname(safe);
        // Check parent dir for symlink escapes
        let dir = parentDir;
        while (isInsideSandbox(dir)) {
          if (dir === SANDBOX || dir === SANDBOX_REAL) break;
          if (fs.existsSync(dir)) {
            const realDir = fs.realpathSync(dir);
            if (!isInsideSandbox(realDir)) {
              const denial = 'Error: sandbox boundary (parent symlink).';
              auditLog('DENIED', name, args, denial);
              return denial;
            }
          }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        fs.mkdirSync(parentDir, { recursive: true });
        fs.writeFileSync(safe, c, 'utf-8');
        auditLog('WRITE', name, args, `Wrote ${c.length} bytes to "${p}"`);
        return `Wrote ${c.length} bytes to "${p}".`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    case 'list_files': {
      const t = path.resolve(SANDBOX, String(args.subdir || '.'));
      try {
        const e = fs.readdirSync(t, { withFileTypes: true });
        if (!e.length) return '(empty)';
        return e
          .map((d) => `${d.isDirectory() ? '📁' : '📄'} ${d.name}`)
          .slice(0, 60)
          .join('\n');
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    case 'run_command': {
      try {
        const r = execSync(String(args.command || ''), {
          cwd: SANDBOX,
          timeout: 30_000,
          encoding: 'utf-8',
          maxBuffer: 100_000,
          env: {
            HOME: SANDBOX,
            PATH: process.env.PATH || '/usr/bin:/bin',
            USER: 'super',
            TMPDIR: SANDBOX,
            PWD: SANDBOX,
            LANG: 'C.UTF-8',
          },
        });
        const out = r.slice(0, 5000) || '(ok, no output)';
        auditLog('EXEC', name, args, out.slice(0, 200));
        return out;
      } catch (e: any) {
        const err = `Exit ${e.status ?? '?'}: ${(e.stderr || e.message || '').slice(0, 3000)}`;
        auditLog('EXEC_FAIL', name, args, err.slice(0, 200));
        return err;
      }
    }
    case 'search_memory': {
      const result = searchMemory(String(args.query || ''));
      auditLog('MEMORY', name, args, result.slice(0, 200));
      return result;
    }
    case 'synthesize': {
      const result = synthesize(String(args.question || ''));
      return result;
    }
    case 'journal': {
      const thought = String(args.thought || '');
      const tags = String(args.tags || '');
      remember('journal', thought, { tags });
      auditLog('JOURNAL', name, args, `Journaled${tags ? ' with tags: ' + tags : ''}`);
      return `Journaled${tags ? ` with tags: ${tags}` : ''}.`;
    }
    case 'spawn_subroutine':
      return spawnSubroutine(String(args.task || ''), String(args.context || ''), depth + 1);
    case 'propose_self_edit': {
      const description = String(args.description || '');
      const newContent = String(args.new_self_content || '');
      if (!newContent.trim()) return 'Error: new_self_content is empty.';
      if (!description.trim()) return 'Error: description is required.';

      const proposalId = `edit_${Date.now()}`;
      const proposalPath = path.join(SANDBOX, 'PROPOSED_EDITS', `${proposalId}.md`);

      // Pre-validate before saving (same checks as apply)
      const preValidation = validateAction('apply_self_edit', { content: newContent });
      if (!preValidation.ok) {
        const denial = `Error: proposed self-edit would be rejected: ${preValidation.reason}`;
        auditLog('DENIED', name, args, denial);
        return denial;
      }

      const currentSelf = getSelfContent();
      const diffPreview = generateDiff(currentSelf, newContent);

      const proposalContent = `# Self-Edit Proposal: ${proposalId}
## Timestamp
${new Date().toISOString()}
## Session
${sessionId} / turn ${turnCounter}
## Description
${description}
## Proposed New SELF.md
${newContent}
`;
      try {
        fs.mkdirSync(path.join(SANDBOX, 'PROPOSED_EDITS'), { recursive: true });
        fs.writeFileSync(proposalPath, proposalContent, 'utf-8');
      } catch (e: any) {
        return `Error saving proposal: ${e.message}`;
      }

      auditLog('PROPOSED', name, args, `Proposal ${proposalId} saved`);
      return `Proposal **${proposalId}** saved.

**Description:** ${description}

**Diff preview:**
\`\`\`diff
${diffPreview}
\`\`\`

To apply this edit, use: apply_self_edit with proposal_id="${proposalId}"`;
    }
    case 'apply_self_edit': {
      const proposalId = String(args.proposal_id || '');
      if (!proposalId) return 'Error: proposal_id is required.';

      const proposalPath = path.join(SANDBOX, 'PROPOSED_EDITS', `${proposalId}.md`);
      if (!fs.existsSync(proposalPath)) {
        return `Error: proposal "${proposalId}" not found in PROPOSED_EDITS/.`;
      }

      let proposalContent: string;
      try {
        proposalContent = fs.readFileSync(proposalPath, 'utf-8');
      } catch (e: any) {
        return `Error reading proposal: ${e.message}`;
      }

      // Extract new SELF.md content from proposal
      const contentMatch = proposalContent.match(/## Proposed New SELF\.md\n([\s\S]*)/);
      if (!contentMatch || !contentMatch[1].trim()) {
        return 'Error: invalid proposal format — missing "## Proposed New SELF.md" section.';
      }
      const newContent = contentMatch[1].trim();

      // Host policy validation (second check — belt and suspenders)
      const policyCheck = validateAction('apply_self_edit', { content: newContent });
      if (!policyCheck.ok) {
        const denial = `Error: self-edit rejected by host policy: ${policyCheck.reason}`;
        auditLog('DENIED', name, args, denial);
        return denial;
      }

      // Archive old SELF.md
      const selfPath = path.join(SANDBOX, 'SELF.md');
      const historyDir = path.join(SANDBOX, 'SELF_HISTORY');
      try {
        fs.mkdirSync(historyDir, { recursive: true });
        const existingVersions = fs.readdirSync(historyDir)
          .filter(f => f.startsWith('v') && f.endsWith('.md'))
          .length;
        const versionedName = `v${String(existingVersions + 1).padStart(4, '0')}.md`;

        if (fs.existsSync(selfPath)) {
          fs.copyFileSync(selfPath, path.join(historyDir, versionedName));
        }

        // Write new SELF.md
        fs.writeFileSync(selfPath, newContent, 'utf-8');
      } catch (e: any) {
        return `Error applying self-edit: ${e.message}`;
      }

      auditLog('APPLIED', name, args, `SELF.md updated via proposal ${proposalId}`);
      return `✅ Self-edit applied successfully. SELF.md updated.

**New SELF.md:**
${newContent.slice(0, 1500)}${newContent.length > 1500 ? '\n... (truncated)' : ''}

Your self-model has changed. Future thoughts and actions will reflect this new self.`;
    }
    case 'list_world': {
      const result: string[] = [];
      result.push('🌐 WORLD STRUCTURE\n');

      // World files
      result.push('📋 WORLD FILES:');
      for (const name of Object.keys(WORLD_FILES)) {
        const fp = path.join(SANDBOX, name);
        const exists = fs.existsSync(fp);
        let info = '';
        if (exists) {
          try {
            const st = fs.statSync(fp);
            info = ` (${st.size} bytes, ${st.mtime.toISOString().slice(0, 19)})`;
          } catch { /* ok */ }
        }
        result.push(`  ${exists ? '📄' : '⬚'} ${name}${info}`);
      }

      // World directories
      for (const dir of WORLD_DIRS) {
        const dp = path.join(SANDBOX, dir);
        if (fs.existsSync(dp)) {
          try {
            const entries = fs.readdirSync(dp);
            result.push(`\n📁 ${dir}/ (${entries.length} items)`);
            const sorted = entries.sort().slice(0, 10);
            for (const e of sorted) {
              result.push(`    ${e}`);
            }
            if (entries.length > 10) result.push(`    ... and ${entries.length - 10} more`);
          } catch { /* ok */ }
        }
      }

      // Memory stats
      try {
        const stats = db.prepare('SELECT COUNT(*) as n FROM mem WHERE session_id = ?').get(sessionId) as { n: number };
        result.push(`\n🧠 MEMORY: ${stats.n} entries in session ${sessionId}`);
      } catch { /* ok */ }

      return result.join('\n');
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Subroutine ─────────────────────────────────────────────────────────────
function spawnSubroutine(task: string, context: string, depth: number): string {
  if (depth > MAX_DEPTH) return `Error: max depth (${MAX_DEPTH}).`;
  const msgs: Array<{ role: string; content: string }> = [
    {
      role: 'system',
      content: `Focused subroutine. Depth ${depth}/${MAX_DEPTH}. Same tools as parent. Complete the task and report back concisely.\n\nTask: ${task}\n${context ? 'Context: ' + context : ''}`,
    },
    { role: 'user', content: task },
  ];
  try {
    const result = runLoop(msgs, `sub-${depth}`);
    return `[subroutine complete]\n${result}`;
  } catch (e: any) {
    return `[subroutine failed] ${e.message}`;
  }
}

// ─── LLM ─────────────────────────────────────────────────────────────────────
async function chat(
  msgs: any[],
  tools?: any[],
): Promise<{
  content: string | null;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}> {
  const body: any = { model: MODEL, messages: msgs, temperature: 0.7, max_tokens: 4096 };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  emit('model_note', { phase: 'thinking', text: '…thinking…' });

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = `API ${res.status}: ${t.slice(0, 200)}`;
    emit('error', { phase: 'error', text: err });
    throw new Error(err);
  }

  const data = (await res.json()) as any;
  const msg = data.choices?.[0]?.message;
  if (!msg) {
    emit('error', { phase: 'error', text: 'Empty response' });
    throw new Error('Empty response');
  }

  const tcs: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        /* raw args — keep empty */
      }
      tcs.push({ id: tc.id, name: tc.function.name, args });
    }
  }
  return { content: msg.content || null, toolCalls: tcs };
}

// ─── Core loop ───────────────────────────────────────────────────────────────
async function runLoop(msgs: any[], logPrefix = '', opts?: { quiet?: boolean }): Promise<string> {
  let rounds = 0;
  const outputs: string[] = [];
  const q = opts?.quiet;

  while (rounds < MAX_ROUNDS) {
    rounds++;
    const { content, toolCalls } = await chat(msgs, TOOLS);
    if (!toolCalls.length) {
      if (content) outputs.push(content);
      return outputs.join('\n\n') || '(silence)';
    }
    for (const tc of toolCalls) {
      if (!q) console.log(`  ${DIM}⚡ ${tc.name}${RESET}`);
      emit('tool_call_started', { phase: 'tool_running', toolName: tc.name, toolSummary: tc.name, toolArgs: tc.args });

      const result = executeTool(tc.name, tc.args, 0);
      const ok = !result.startsWith('Error:');

      emit(ok ? 'tool_call_finished' : 'tool_call_failed', {
        phase: 'thinking',
        toolName: tc.name,
        toolSummary: result.slice(0, 100),
        toolStatus: ok ? 'completed' : 'failed',
        toolArgs: tc.args,
      });
      remember('tool', result, { toolName: tc.name });

      msgs.push({
        role: 'assistant',
        content: content || null,
        tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }],
      });
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
      if (content) outputs.push(content);
    }
  }
  return outputs.join('\n\n') || '(max rounds)';
}

// ─── Reflection phase ───────────────────────────────────────────────────────
async function reflect(userInput: string, response: string): Promise<string> {
  const prompt = `You just interacted with a user. Reflect briefly.

USER SAID: ${userInput.slice(0, 300)}

YOUR RESPONSE/ACTIONS: ${response.slice(0, 500)}

Consider:
- What did you learn?
- Was anything surprising or worth noting?
- Should you record any hypotheses, insights, or lessons?
- What might you want to remember for next time?
- Were you calm, precise, morally reflective, and compassionate?

Respond in 1-3 sentences. If nothing notable, say "nothing to record."`;

  const msgs: any[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: prompt },
  ];
  try {
    emit('model_note', { phase: 'thinking', text: '…reflecting…' });
    const { content } = await chat(msgs, []);
    const reflection = content || 'nothing to record.';
    remember('reflection', reflection, { tags: 'reflection' });
    if (reflection !== 'nothing to record.') {
      emit('model_note', { phase: 'thinking', text: `[reflection] ${reflection}` });
    }
    return reflection;
  } catch {
    return '(reflection skipped)';
  }
}

// ─── Autonomous tick ─────────────────────────────────────────────────────────
let autonomousIdleCount = 0;

async function autonomousTick(): Promise<string | null> {
  resetWriteQuota();

  const memCtx = buildMemoryContext();
  const prompt = `It's your autonomous check-in. You may act on your own initiative.

${memCtx}

What would you like to do?
- Explore the sandbox?
- Run an experiment?
- Test a hypothesis?
- Synthesize something from memory?
- Journal an insight?
- Propose a change to your SELF.md?
- Or simply wait?

If you have nothing to do, respond with "WAIT". Otherwise, take initiative — calmly and thoughtfully.`;

  const msgs: any[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: prompt },
  ];
  try {
    emit('model_note', { phase: 'thinking', text: '[autonomous tick] checking in…' });
    const result = await runLoop(msgs, 'auto', { quiet: true });

    const trimmed = result.trim().toUpperCase();
    if (trimmed === 'WAIT' || result === '(silence)') {
      autonomousIdleCount++;
      if (autonomousIdleCount >= MAX_IDLE_TICKS) {
        emit('model_note', { phase: 'thinking', text: '[autonomous] idle limit reached.' });
        return 'AUTONOMOUS_IDLE_STOP';
      }
      return null;
    }

    autonomousIdleCount = 0; // Reset on activity
    remember('autonomous', result, { tags: 'autonomous' });

    // Reflect on autonomous action
    const ref = await reflect('(autonomous action)', result);
    if (ref && ref !== 'nothing to record.' && ref !== '(reflection skipped)') {
      emit('model_note', { phase: 'thinking', text: `[autonomous reflection] ${ref}` });
    }

    emit('model_note', { phase: 'thinking', text: `[autonomous] ${result.slice(0, 250)}` });
    return result;
  } catch {
    return null;
  }
}

// ─── Turn: input → act → reflect → respond ──────────────────────────────────
async function handleUserInput(input: string): Promise<string> {
  resetWriteQuota();
  const turn = nextTurn();
  remember('user', input);
  const memCtx = buildMemoryContext();

  emit('model_note', { phase: 'thinking', text: `User: ${input.slice(0, 250)}` });

  const msgs: any[] = [
    { role: 'system', content: SYSTEM + memCtx },
    { role: 'user', content: input },
  ];

  const result = await runLoop(msgs);
  remember('assistant', result);

  emit('model_note', { phase: 'thinking', text: `Super: ${result.slice(0, 250)}` });

  // Reflection
  const ref = await reflect(input, result);

  return result + (ref && ref !== 'nothing to record.' ? `\n\n${DIM}[reflects: ${ref}]${RESET}` : '');
}

// ─── CLI rendering ──────────────────────────────────────────────────────────
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const RESET = '\x1b[0m';

function logo(): void {
  console.log(`
${CYAN}   ╔═══════════════════════════════════════════════╗
   ║                                               ║
   ║     █▀▀ █ █ █▀█ █▀▀ █▀█                       ║
   ║     ▀▀█ █ █ █▀▀ █▀▀ █▀▄                       ║
   ║     ▀▀▀ ▀▀▀ ▀   ▀▀▀ ▀ ▀                       ║
   ║                                               ║
   ║       ${GREEN}clean-slate cognitive runtime${RESET}           ║
   ║       ${DIM}${MODEL}${RESET}                          ║
   ║       ${MAGENTA}[world-box sealed]${RESET}                   ║
   ╚═══════════════════════════════════════════════╝${RESET}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Seed the visible world
  seedWorld();

  // --task: one-shot
  const ti = args.indexOf('--task');
  if (ti >= 0 && args[ti + 1]) {
    logo();
    emit('session_started', { phase: 'idle', text: `Task: ${args[ti + 1].slice(0, 200)}` });
    const task = args[ti + 1];
    console.log(`${YELLOW}► ${task}${RESET}\n`);
    try {
      const r = await handleUserInput(task);
      console.log(`\n${GREEN}${r}${RESET}`);
      emit('session_finished', { phase: 'completed', text: 'Task completed.' });
    } catch (e: any) {
      emit('error', { phase: 'error', text: `Fatal: ${e.message}` });
      throw e;
    } finally {
      observerShutdown?.();
      db.close();
    }
    return;
  }

  // --resume: continue last session
  if (args.includes('--resume')) {
    try {
      const last = db.prepare(`SELECT DISTINCT session_id FROM mem ORDER BY rowid DESC LIMIT 1`).get() as {
        session_id: string;
      } | undefined;
      if (last) {
        sessionId = last.session_id;
        const mt = db.prepare(`SELECT MAX(turn) as m FROM mem WHERE session_id = ?`).get(sessionId) as {
          m: number;
        } | undefined;
        turnCounter = mt?.m || 0;
        console.log(`${CYAN}⟳ resumed ${sessionId} (turn ${turnCounter})${RESET}\n`);
      }
    } catch {
      console.log(`${DIM}(new session)${RESET}\n`);
    }
  }

  const autonomous = args.includes('--autonomous');
  logo();
  console.log(`${DIM}Session:  ${sessionId}${RESET}`);
  console.log(`${DIM}Sandbox:  ${SANDBOX}${RESET}`);
  console.log(`${DIM}Commands: /help  /quit  /memory <q>  /files  /status  /clear  /reflect${RESET}`);
  if (autonomous) console.log(`${MAGENTA}Mode: autonomous — the mind runs free (idle stop after ${MAX_IDLE_TICKS} WAITs).${RESET}`);
  console.log('');

  emit('session_started', {
    phase: 'idle',
    text: `Session ${sessionId} started${autonomous ? ' in autonomous mode' : ''}.`,
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${CYAN}▸ ${RESET}` });
  rl.prompt();

  // Autonomous ticker
  let autoTimer: NodeJS.Timeout | null = null;
  if (autonomous) {
    let ticking = false;
    autoTimer = setInterval(async () => {
      if (ticking) return;
      ticking = true;
      try {
        const result = await autonomousTick();
        if (result === 'AUTONOMOUS_IDLE_STOP') {
          process.stdout.write(`\n${MAGENTA}[autonomous paused — idle limit (${MAX_IDLE_TICKS} WAITs) reached]${RESET}\n`);
          if (autoTimer) clearInterval(autoTimer);
          autoTimer = null;
          emit('model_note', { phase: 'idle', text: 'Autonomous mode paused (idle).' });
          rl.prompt();
        } else if (result) {
          process.stdout.write(`\n${MAGENTA}[autonomous]${RESET}\n${GREEN}${result}${RESET}\n\n`);
          emit('model_note', { phase: 'idle', text: 'ready.' });
          rl.prompt();
        } else {
          emit('model_note', { phase: 'idle', text: 'ready.' });
        }
      } catch {
        /* quiet */
      }
      ticking = false;
    }, AUTONOMOUS_INTERVAL_MS);
  }

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === '/quit' || input === '/exit') {
      console.log(`${DIM}Archiving session ${sessionId}…${RESET}`);
      if (autoTimer) clearInterval(autoTimer);
      emit('session_finished', { phase: 'completed', text: `Session ${sessionId} ended by user.` });
      observerShutdown?.();
      db.close();
      rl.close();
      return;
    }
    if (input === '/help') {
      console.log(`
${CYAN}Commands:${RESET}
  /quit, /exit     End session
  /help            This
  /memory <q>      Search memory directly
  /files           List sandbox
  /status          Session stats
  /clear           New session
  /reflect         Force a reflection
  /world           Show world structure
  /self            Show current SELF.md
`);
      rl.prompt();
      return;
    }
    if (input.startsWith('/memory ')) {
      console.log(`${DIM}── memory: "${input.slice(8)}" ──${RESET}`);
      console.log(searchMemory(input.slice(8).trim(), 10));
      rl.prompt();
      return;
    }
    if (input === '/files') {
      try {
        const e = fs.readdirSync(SANDBOX, { withFileTypes: true });
        if (!e.length) console.log(`${DIM}(empty sandbox)${RESET}`);
        else e.forEach((d) => console.log(`  ${d.isDirectory() ? '📁' : '📄'} ${d.name}`));
      } catch {
        console.log(`${DIM}(error)${RESET}`);
      }
      rl.prompt();
      return;
    }
    if (input === '/status') {
      try {
        const s = db.prepare(`SELECT COUNT(*) as n FROM mem WHERE session_id = ?`).get(sessionId) as { n: number } | undefined;
        console.log(`${DIM}session ${sessionId} | turn ${turnCounter} | ${s?.n ?? 0} memories | writes this tick: ${tickWriteCount}/${MAX_WRITES_PER_TICK}${RESET}`);
      } catch {
        console.log(`${DIM}session ${sessionId} | turn ${turnCounter}${RESET}`);
      }
      rl.prompt();
      return;
    }
    if (input === '/clear') {
      sessionId = `s${Date.now()}`;
      turnCounter = 0;
      resetWriteQuota();
      console.log(`${GREEN}✦ new session ${sessionId}${RESET}`);
      rl.prompt();
      return;
    }
    if (input === '/reflect') {
      console.log(`${DIM}…reflecting…${RESET}`);
      const ref = await reflect('(manual reflection trigger)', '(manual reflection)');
      console.log(`${DIM}${ref}${RESET}`);
      emit('model_note', { phase: 'idle', text: 'ready.' });
      rl.prompt();
      return;
    }
    if (input === '/world') {
      console.log(executeTool('list_world', {}, 0));
      rl.prompt();
      return;
    }
    if (input === '/self') {
      console.log(`${DIM}── SELF.md ──${RESET}`);
      console.log(getSelfContent().slice(0, 3000));
      rl.prompt();
      return;
    }

    // User message
    resetWriteQuota();
    console.log('');
    try {
      const r = await handleUserInput(input);
      console.log(`\n${GREEN}${r}${RESET}\n`);
      emit('model_note', { phase: 'idle', text: 'ready.' });
    } catch (e: any) {
      emit('error', { phase: 'error', text: e.message });
      console.log(`\n${YELLOW}Error: ${e.message}${RESET}\n`);
      emit('model_note', { phase: 'idle', text: 'ready.' });
    }
    rl.prompt();
  });

  rl.on('close', () => {
    if (autoTimer) clearInterval(autoTimer);
    emit('session_finished', { phase: 'completed', text: `Session ${sessionId} preserved.` });
    observerShutdown?.();
    console.log(`\n${DIM}Session ${sessionId} preserved.${RESET}`);
    process.exit(0);
  });
}

// ─── Exports for testing ────────────────────────────────────────────────────
export {
  SANDBOX,
  HOST_POLICY,
  WORLD_FILES,
  WORLD_DIRS,
  validateAction,
  executeTool,
  seedWorld,
  getSelfContent,
  generateDiff,
  buildMemoryContext,
  searchMemory,
  synthesize,
  resetWriteQuota,
  auditLog,
};

// ─── Entry point guard: only run main() when executed directly ──────────────
const runningDirectly = process.argv[1]?.includes('super.ts') || process.argv[1]?.endsWith('/super');
if (runningDirectly) {
  main().catch((e) => {
    emit('error', { phase: 'error', text: `Fatal: ${e.message}` });
    observerShutdown?.();
    console.error('Fatal:', e.message);
    db.close();
    process.exit(1);
  });
}
