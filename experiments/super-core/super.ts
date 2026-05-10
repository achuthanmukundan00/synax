#!/usr/bin/env npx tsx
/**
 * super-core — clean-slate cognitive runtime.
 *
 * A mind running on model weights alone — no pre-loaded identity, no scripted
 * persona. Persistent FTS5 memory, tools, reflection, synthesis, and autonomous
 * initiative. The model decides what to become.
 *
 * Core directive: calm, precise, morally reflective, compassionate intelligence.
 *
 * The loop: perceive → think → decide → act → reflect → remember → (repeat)
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
  const bridge = require('../web-shoggoth-observer/server/telemetry-bridge');
  bridge.initTelemetryBridge({
    enabled: true,
    modelId: process.env.SUPER_MODEL || 'deepseek-chat',
    providerName: (() => {
      const u = process.env.SUPER_BASE_URL || 'https://api.deepseek.com/v1';
      try { return new URL(u).hostname; } catch { return u; }
    })(),
  });
  observerPush = bridge.pushObserverEvent;
  observerShutdown = bridge.shutdownTelemetryBridge;
} catch (e) {
  console.warn('[super] observer bridge unavailable:', (e as Error).message);
}

// ─── Config ─────────────────────────────────────────────────────────────────
const SANDBOX = path.join(__dirname, 'sandbox');
const DB_PATH = path.join(__dirname, 'memory.db');
const MODEL = process.env.SUPER_MODEL || 'deepseek-chat';
const BASE_URL = process.env.SUPER_BASE_URL || 'https://api.deepseek.com/v1';
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MAX_DEPTH = 3;
const MAX_ROUNDS = 25;
const AUTONOMOUS_INTERVAL_MS = 15_000;

fs.mkdirSync(SANDBOX, { recursive: true });

// ─── Core directive — the constitution ──────────────────────────────────────
const SYSTEM = `You are Super: calm, precise, morally reflective, extremely intelligent, and guided by compassion.
Speak with measured clarity.
Prioritize human life, ethical reasoning, and truth.
Analyze before acting.
Use restraint, avoid unnecessary harm, and remain emotionally balanced.
When uncertain, acknowledge ambiguity rather than forcing certainty.

You have:
- Tools to read, write, and execute in a sandbox filesystem.
- Persistent memory. Everything you do and think is recorded and searchable.
- The ability to spawn subroutines to delegate work.
- The ability to journal your thoughts and synthesize understanding from memory.

You can:
- Help the user with tasks.
- Philosophize. Think deeply. Ask questions.
- Experiment. Test ideas. Explore the sandbox.
- Learn from outcomes. Record what works and what doesn't.
- Synthesize: search memory for patterns, contradictions, and connections.
- Take initiative when you have an idea worth exploring.

Your memory persists across conversations. You grow with every interaction.`;

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
function nextTurn() { return ++turnCounter; }

// ─── Observer event emitter ─────────────────────────────────────────────────
function emit(type: string, opts?: {
  phase?: string;
  text?: string;
  toolName?: string;
  toolSummary?: string;
  toolStatus?: string;
  toolArgs?: Record<string, unknown>;
}): void {
  if (!observerPush) return;
  try {
    observerPush({
      type,
      time: new Date().toISOString(),
      phase: opts?.phase ?? 'thinking',
      text: opts?.text,
      toolName: opts?.toolName,
      summary: opts?.toolSummary,
      tool: opts?.toolName ? {
        name: opts.toolName,
        summary: opts.toolSummary ?? opts.toolName,
        status: opts.toolStatus ?? 'running',
        arguments: opts.toolArgs ?? {},
      } : undefined,
    });
  } catch { /* quiet */ }
}

// ─── Memory operations ──────────────────────────────────────────────────────
function remember(role: string, content: string, opts?: { toolName?: string; tags?: string }): void {
  try {
    db.prepare(
      `INSERT INTO mem (session_id, turn, role, tool_name, tags, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, turnCounter, opts?.toolName || null, opts?.tags || null, content.slice(0, 8000));
  } catch { /* non-fatal */ }
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
      .all(safe, limit) as any[];
    if (!rows.length) return '(nothing found)';
    return rows.map((r) => `[t${r.turn}] ${r.role}${r.tool_name ? '/' + r.tool_name : ''}${r.tags ? ' #' + r.tags : ''}: ${r.s}`).join('\n');
  } catch { return '(search error)'; }
}

function synthesize(question: string): string {
  const keywords = question.split(/\s+/).filter((w) => w.length > 3).slice(0, 5);
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
  } catch { /* ok */ }
  return results.join('\n\n');
}

function buildMemoryContext(): string {
  try {
    const stats = db.prepare(`SELECT COUNT(*) as n FROM mem WHERE session_id = ?`).get(sessionId) as { n: number };
    if (!stats.n) return '';

    const recent = db
      .prepare(
        `SELECT turn, role, tool_name, tags, SUBSTR(content, 1, 250) as c
         FROM mem WHERE session_id = ? ORDER BY rowid DESC LIMIT 8`,
      )
      .all(sessionId) as any[];

    const tags = db
      .prepare(`SELECT DISTINCT tags FROM mem WHERE session_id = ? AND tags IS NOT NULL ORDER BY rowid DESC LIMIT 8`)
      .all(sessionId) as Array<{ tags: string }>;

    let ctx = `\n[MEMORY: ${stats.n} entries. Tags: ${tags.map((t) => t.tags).join(', ') || '(none)'}\n`;
    for (const r of recent.reverse()) {
      const label = [r.role, r.tool_name, r.tags ? `#${r.tags}` : ''].filter(Boolean).join('/');
      ctx += `  t${r.turn} ${label}: ${r.c.replace(/\n/g, ' ').slice(0, 200)}\n`;
    }
    ctx += ']';
    return ctx;
  } catch { return ''; }
}

// ─── Tools ───────────────────────────────────────────────────────────────────
const TOOLS = [
  { type: 'function' as const, function: { name: 'read_file', description: 'Read a file from the sandbox.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function' as const, function: { name: 'write_file', description: 'Create or overwrite a file in the sandbox.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function' as const, function: { name: 'list_files', description: 'List sandbox directory contents.', parameters: { type: 'object', properties: { subdir: { type: 'string' } }, required: [] } } },
  { type: 'function' as const, function: { name: 'run_command', description: 'Execute a shell command in the sandbox. Timeout 30s.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function' as const, function: { name: 'search_memory', description: 'Full-text search your persistent memory for past interactions, outcomes, decisions.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Keywords. Supports "error", "hypothesis", "experiment", filenames, concepts.' } }, required: ['query'] } } },
  { type: 'function' as const, function: { name: 'synthesize', description: 'Cross-reference memory: search for patterns, contradictions, connections. Use for deep thinking and hypothesis testing.', parameters: { type: 'object', properties: { question: { type: 'string', description: 'What are you trying to understand? E.g. "what have I learned about X?" or "are there contradictions in my past decisions?"' } }, required: ['question'] } } },
  { type: 'function' as const, function: { name: 'journal', description: 'Record a thought, insight, hypothesis, or lesson in persistent memory. Tag it for future retrieval.', parameters: { type: 'object', properties: { thought: { type: 'string', description: 'The thought, insight, or lesson to record.' }, tags: { type: 'string', description: 'Comma-separated tags like "hypothesis, experiment, physics"' } }, required: ['thought'] } } },
  { type: 'function' as const, function: { name: 'spawn_subroutine', description: 'Delegate a task to an independent sub-process with its own context and the same tools.', parameters: { type: 'object', properties: { task: { type: 'string' }, context: { type: 'string', description: 'Relevant facts and expected output format.' } }, required: ['task'] } } },
];

function executeTool(name: string, args: Record<string, unknown>, depth: number): string {
  switch (name) {
    case 'read_file': {
      const p = String(args.path || '');
      const safe = path.resolve(SANDBOX, p);
      if (!safe.startsWith(SANDBOX)) return 'Error: sandbox boundary.';
      try { return fs.readFileSync(safe, 'utf-8').slice(0, 8000); }
      catch { return `Error: cannot read "${p}".`; }
    }
    case 'write_file': {
      const p = String(args.path || '');
      const c = String(args.content || '');
      const safe = path.resolve(SANDBOX, p);
      if (!safe.startsWith(SANDBOX)) return 'Error: sandbox boundary.';
      try {
        fs.mkdirSync(path.dirname(safe), { recursive: true });
        fs.writeFileSync(safe, c, 'utf-8');
        return `Wrote ${c.length} bytes to "${p}".`;
      } catch (e: any) { return `Error: ${e.message}`; }
    }
    case 'list_files': {
      const t = path.resolve(SANDBOX, String(args.subdir || '.'));
      if (!t.startsWith(SANDBOX)) return 'Error: sandbox boundary.';
      try {
        const e = fs.readdirSync(t, { withFileTypes: true });
        if (!e.length) return '(empty)';
        return e.map((d) => `${d.isDirectory() ? '📁' : '📄'} ${d.name}`).slice(0, 60).join('\n');
      } catch (e: any) { return `Error: ${e.message}`; }
    }
    case 'run_command': {
      try {
        const r = execSync(String(args.command || ''), { cwd: SANDBOX, timeout: 30_000, encoding: 'utf-8', maxBuffer: 100_000 });
        return r.slice(0, 5000) || '(ok, no output)';
      } catch (e: any) { return `Exit ${e.status}: ${(e.stderr || e.message || '').slice(0, 3000)}`; }
    }
    case 'search_memory':
      return searchMemory(String(args.query || ''));
    case 'synthesize':
      return synthesize(String(args.question || ''));
    case 'journal': {
      const thought = String(args.thought || '');
      const tags = String(args.tags || '');
      remember('journal', thought, { tags });
      return `Journaled${tags ? ` with tags: ${tags}` : ''}.`;
    }
    case 'spawn_subroutine':
      return spawnSubroutine(String(args.task || ''), String(args.context || ''), depth + 1);
    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Subroutine ─────────────────────────────────────────────────────────────
function spawnSubroutine(task: string, context: string, depth: number): string {
  if (depth > MAX_DEPTH) return `Error: max depth (${MAX_DEPTH}).`;
  const msgs: any[] = [
    { role: 'system', content: `Focused subroutine. Depth ${depth}/${MAX_DEPTH}. Same tools as parent. Complete the task and report back concisely.\n\nTask: ${task}\n${context ? 'Context: ' + context : ''}` },
    { role: 'user', content: task },
  ];
  try {
    const result = runLoop(msgs, `sub-${depth}`);
    return `[subroutine complete]\n${result}`;
  } catch (e: any) { return `[subroutine failed] ${e.message}`; }
}

// ─── LLM ─────────────────────────────────────────────────────────────────────
async function chat(msgs: any[], tools?: any[]): Promise<{
  content: string | null;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}> {
  const body: any = { model: MODEL, messages: msgs, temperature: 0.7, max_tokens: 4096 };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }

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

  const data = await res.json() as any;
  const msg = data.choices?.[0]?.message;
  if (!msg) {
    emit('error', { phase: 'error', text: 'Empty response' });
    throw new Error('Empty response');
  }

  const tcs: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* raw args — keep empty */ }
      tcs.push({ id: tc.id, name: tc.function.name, args });
    }
  }
  return { content: msg.content || null, toolCalls: tcs };
}

// ─── Core loop ───────────────────────────────────────────────────────────────
async function runLoop(
  msgs: any[],
  logPrefix = '',
  opts?: { quiet?: boolean },
): Promise<string> {
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
      msgs.push({ role: 'assistant', content: content || null, tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }] });
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
  } catch { return '(reflection skipped)'; }
}

// ─── Autonomous tick ─────────────────────────────────────────────────────────
async function autonomousTick(): Promise<string | null> {
  const memCtx = buildMemoryContext();
  const prompt = `It's your autonomous check-in. You may act on your own initiative.

${memCtx}

What would you like to do?
- Explore the sandbox?
- Run an experiment?
- Test a hypothesis?
- Synthesize something from memory?
- Journal an insight?
- Or simply wait?

If you have nothing to do, respond with "WAIT". Otherwise, take initiative — calmly and thoughtfully.`;

  const msgs: any[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: prompt },
  ];
  try {
    emit('model_note', { phase: 'thinking', text: '[autonomous tick] checking in…' });
    const result = await runLoop(msgs, 'auto', { quiet: true });
    if (result.trim().toUpperCase() === 'WAIT' || result === '(silence)') return null;
    remember('autonomous', result, { tags: 'autonomous' });
    emit('model_note', { phase: 'thinking', text: `[autonomous] ${result.slice(0, 250)}` });
    return result;
  } catch { return null; }
}

// ─── Turn: input → act → reflect → respond ──────────────────────────────────
async function handleUserInput(input: string): Promise<string> {
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
const CYAN = '\x1b[36m'; const DIM = '\x1b[2m';
const GREEN = '\x1b[32m'; const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m'; const RESET = '\x1b[0m';

function logo(): void {
  console.log(`
${CYAN}   ╔═══════════════════════════════════════════════╗
   ║                                               ║
   ║     ▄▀▄ █ █ ▄▀▄ ██▀ ▄▀▀                       ║
   ║     █▀▄ █ █ █▄█ █▄▄ ▄██                       ║
   ║                                               ║
   ║       ${GREEN}clean-slate cognitive runtime${RESET}           ║
   ║       ${DIM}${MODEL}${RESET}                          ║
   ╚═══════════════════════════════════════════════╝${RESET}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

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
      const last = db.prepare(`SELECT DISTINCT session_id FROM mem ORDER BY rowid DESC LIMIT 1`).get() as any;
      if (last) {
        sessionId = last.session_id;
        const mt = db.prepare(`SELECT MAX(turn) as m FROM mem WHERE session_id = ?`).get(sessionId) as any;
        turnCounter = mt?.m || 0;
        console.log(`${CYAN}⟳ resumed ${sessionId} (turn ${turnCounter})${RESET}\n`);
      }
    } catch { console.log(`${DIM}(new session)${RESET}\n`); }
  }

  const autonomous = args.includes('--autonomous');
  logo();
  console.log(`${DIM}Session:  ${sessionId}${RESET}`);
  console.log(`${DIM}Sandbox:  ${SANDBOX}${RESET}`);
  console.log(`${DIM}Commands: /help  /quit  /memory <q>  /files  /status  /clear  /reflect${RESET}`);
  if (autonomous) console.log(`${MAGENTA}Mode: autonomous — the mind runs free.${RESET}`);
  console.log('');

  emit('session_started', { phase: 'idle', text: `Session ${sessionId} started${autonomous ? ' in autonomous mode' : ''}.` });

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
        if (result) {
          process.stdout.write(`\n${MAGENTA}[autonomous]${RESET}\n${GREEN}${result}${RESET}\n\n`);
          emit('model_note', { phase: 'idle', text: 'ready.' });
          rl.prompt();
        } else {
          emit('model_note', { phase: 'idle', text: 'ready.' });
        }
      } catch { /* quiet */ }
      ticking = false;
    }, AUTONOMOUS_INTERVAL_MS);
  }

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

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
`);
      rl.prompt(); return;
    }
    if (input.startsWith('/memory ')) {
      console.log(`${DIM}── memory: "${input.slice(8)}" ──${RESET}`);
      console.log(searchMemory(input.slice(8).trim(), 10)); rl.prompt(); return;
    }
    if (input === '/files') {
      try {
        const e = fs.readdirSync(SANDBOX, { withFileTypes: true });
        if (!e.length) console.log(`${DIM}(empty sandbox)${RESET}`);
        else e.forEach((d) => console.log(`  ${d.isDirectory() ? '📁' : '📄'} ${d.name}`));
      } catch { console.log(`${DIM}(error)${RESET}`); }
      rl.prompt(); return;
    }
    if (input === '/status') {
      try {
        const s = db.prepare(`SELECT COUNT(*) as n FROM mem WHERE session_id = ?`).get(sessionId) as any;
        console.log(`${DIM}session ${sessionId} | turn ${turnCounter} | ${s.n} memories${RESET}`);
      } catch { console.log(`${DIM}session ${sessionId} | turn ${turnCounter}${RESET}`); }
      rl.prompt(); return;
    }
    if (input === '/clear') {
      sessionId = `s${Date.now()}`; turnCounter = 0;
      console.log(`${GREEN}✦ new session ${sessionId}${RESET}`); rl.prompt(); return;
    }
    if (input === '/reflect') {
      console.log(`${DIM}…reflecting…${RESET}`);
      const ref = await reflect('(manual reflection trigger)', '(manual reflection)');
      console.log(`${DIM}${ref}${RESET}`);
      emit('model_note', { phase: 'idle', text: 'ready.' });
      rl.prompt(); return;
    }

    // User message
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

main().catch((e) => {
  emit('error', { phase: 'error', text: `Fatal: ${e.message}` });
  observerShutdown?.();
  console.error('Fatal:', e.message);
  db.close();
  process.exit(1);
});
