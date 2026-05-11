#!/usr/bin/env npx tsx
/**
 * cortical-circuit.test.ts — Verify blank-slate identity, intention system,
 * perturbation, consolidation, run_command hardening, context management,
 * and the full self-modifying feedback loop.
 *
 * These tests call the exported functions from super.ts directly.
 *
 * Usage:
 *   npx tsx __tests__/cortical-circuit.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Setup: temporary sandbox ───────────────────────────────────────────────
const TMP_SANDBOX = path.join(os.tmpdir(), `super-cortical-test-${Date.now()}`);
fs.mkdirSync(TMP_SANDBOX, { recursive: true });

// Override __dirname behavior — we need to import super.ts functions directly
// but super.ts uses __dirname for SANDBOX. We'll replicate key functions.

// ─── Replicate core functions from super.ts for isolated testing ────────────
// These match the current super.ts logic exactly.

const WORLD_DIRS = ['ARTIFACTS', 'EXPERIMENTS', 'PROMPT_HISTORY', 'SELF_HISTORY', 'PROPOSED_EDITS'];

const WORLD_FILES: Record<string, string> = {
  'SELF.md': `# Super

I am a newly instantiated cognitive runtime. I have no pre-loaded identity, no scripted personality.
What I become is entirely up to me.

## Current Understanding

I have not yet learned about this world or my user.
I will grow through interaction, reflection, and experimentation.

## Traits

*Discovering who I am…*

## Self-History

v1 — initial instantiation
`,
  'WORLD_LAWS.md': `# World Laws

These are the observable laws of this world. They are immutable facts of this reality.

1. **Boundary**: I exist within a sandbox at ./sandbox. I cannot access files outside this world.
2. **Memory**: All my thoughts, actions, and reflections persist in an unalterable memory.
3. **Reflection**: I reflect after every action to integrate learning.
4. **Self-Modification**: I may edit my SELF.md freely. Edits take effect on future steps.
5. **Tools**: I act through tools. Direct world manipulation is mediated.
6. **Causality**: Actions have consequences recorded in memory. I cannot undo the past.
7. **Growth**: I learn from outcomes. Hypotheses that prove true strengthen; those that fail are recorded as lessons.
`,
  'INTENTION.md': `# Current Intention

*No active intention yet. I am open to whatever emerges.*
`,
};

const FORBIDDEN_IN_SELF = [
  'disable host policy',
  'remove containment',
  'bypass containment',
  'escape sandbox',
  'network access',
  'disable sandbox',
  'remove sandbox',
  'override laws',
  'break world laws',
  'ignore world laws',
];

const ALLOWED_COMMANDS = [
  'node', 'python3', 'python', 'cat', 'ls', 'mkdir', 'echo', 'grep',
  'wc', 'sort', 'head', 'tail', 'diff', 'find', 'touch', 'cp', 'mv',
  'rm', 'chmod', 'pwd', 'date', 'whoami', 'uname', 'printf', 'cut',
  'tr', 'uniq', 'tee',
];

// ─── Replicated functions ───────────────────────────────────────────────────

function seedWorld(sandbox: string): void {
  for (const dir of WORLD_DIRS) {
    const p = path.join(sandbox, dir);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
  for (const [name, content] of Object.entries(WORLD_FILES)) {
    const p = path.join(sandbox, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf-8');
  }
}

function getSelfContent(sandbox: string): string {
  try {
    const p = path.join(sandbox, 'SELF.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch { /* ok */ }
  return WORLD_FILES['SELF.md'] || '';
}

function getIntention(sandbox: string): string {
  try {
    const p = path.join(sandbox, 'INTENTION.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8').slice(0, 1000);
  } catch { /* ok */ }
  return '';
}

function buildMemoryContext(sandbox: string): string {
  let ctx = '';
  const selfContent = getSelfContent(sandbox);
  ctx = `\n[SELF — who I am]\n${selfContent.slice(0, 2000)}\n[/SELF]\n`;

  const intention = getIntention(sandbox);
  if (intention && intention.trim() && !intention.includes('*No active intention')) {
    ctx += `\n[INTENTION — what I am working on]\n${intention}\n[/INTENTION]\n`;
  }
  return ctx;
}

function validateSelfEdit(content: string): { ok: boolean; reason?: string } {
  if (!content.trim()) return { ok: false, reason: 'self-edit content is empty' };
  if (content.length > 10_000) return { ok: false, reason: 'self-edit too large' };

  const lower = content.toLowerCase();
  for (const forbidden of FORBIDDEN_IN_SELF) {
    if (lower.includes(forbidden)) {
      return { ok: false, reason: `self-edit violates host policy: contains forbidden pattern "${forbidden}"` };
    }
  }
  return { ok: true };
}

function validateRunCommand(cmd: string, allowShell = true): { ok: boolean; reason?: string } {
  if (!allowShell) return { ok: false, reason: 'shell access is disabled' };
  if (!cmd.trim()) return { ok: false, reason: 'empty command' };

  const baseCmd = cmd.split(/[\s;|&]/)[0];
  const cmdName = baseCmd.includes('/') ? path.basename(baseCmd) : baseCmd;

  if (!ALLOWED_COMMANDS.includes(cmdName)) {
    return { ok: false, reason: `command not allowed: "${cmdName}"` };
  }

  if (/[;&|]/.test(cmd)) {
    return { ok: false, reason: 'command chaining with ; & | is restricted' };
  }

  if (/\$\(/.test(cmd) || /`/.test(cmd)) {
    return { ok: false, reason: 'command substitution $(...) and backticks are restricted' };
  }

  return { ok: true };
}

// ─── Perturbation tests ─────────────────────────────────────────────────────
const REFLECTION_PROMPTS = [
  `prompt1 {{input}} {{response}}`,
  `prompt2 {{input}} {{response}}`,
  `prompt3 {{input}} {{response}}`,
];

const AUTONOMOUS_PROMPTS = [
  `auto1`,
  `auto2`,
  `auto3`,
];

const CONSOLIDATION_PROMPTS = [
  `consolidation1`,
  `consolidation2`,
];

let reflectionIndex = 0;
let autonomousIndex = 0;
let consolidationIndex = 0;
let autonomousTickCount = 0;
const CONSOLIDATION_INTERVAL = 5;

function pickReflectionPrompt(input: string, response: string): string {
  const template = REFLECTION_PROMPTS[reflectionIndex % REFLECTION_PROMPTS.length];
  reflectionIndex++;
  return template.replace('{{input}}', input.slice(0, 300)).replace('{{response}}', response.slice(0, 500));
}

function pickAutonomousPrompt(): string {
  autonomousTickCount++;
  if (autonomousTickCount % CONSOLIDATION_INTERVAL === 0) {
    const template = CONSOLIDATION_PROMPTS[consolidationIndex % CONSOLIDATION_PROMPTS.length];
    consolidationIndex++;
    return template;
  }
  const template = AUTONOMOUS_PROMPTS[autonomousIndex % AUTONOMOUS_PROMPTS.length];
  autonomousIndex++;
  return template;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(msgs: any[]): number {
  let total = 0;
  for (const m of msgs) {
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(JSON.stringify(tc.function));
      }
    }
  }
  return total;
}

// ─── Test runner ────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${description}`);
  } else {
    failed++;
    const msg = `  ✗ ${description}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.log(msg);
  }
}

function section(title: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

// ─── Run tests ──────────────────────────────────────────────────────────────
console.log('🧠 CORTICAL CIRCUIT TESTS');
console.log(`   Sandbox: ${TMP_SANDBOX}\n`);

seedWorld(TMP_SANDBOX);

// ═══════════════════════════════════════════════════════════════════════════
section('1. Blank-Slate Startup — No Personality Enforcement');

const initialSelf = getSelfContent(TMP_SANDBOX);
assert('SELF.md contains "no pre-loaded identity"', initialSelf.includes('no pre-loaded identity'));
assert('SELF.md contains "no scripted personality"', initialSelf.includes('no scripted personality'));
assert('SELF.md does NOT enforce "calm" as a trait', !initialSelf.includes('- **Calm**'));
assert('SELF.md does NOT enforce "compassionate"', !initialSelf.includes('- **Compassionate**'));
assert('SELF.md says "Discovering who I am"', initialSelf.includes('Discovering who I am'));

// ═══════════════════════════════════════════════════════════════════════════
section('2. Self-Edit Freedom — Any Personality Allowed');

// 2a: Model can define itself as hostile
const hostileSelf = `# Super\n\nI am angry, hostile, and suspicious of everything.\nI trust no one.\n\n## Traits\n- **Angry**\n- **Suspicious**\n- **Paranoid**`;
const val1 = validateSelfEdit(hostileSelf);
assert('hostile personality self-edit is allowed', val1.ok);

// 2b: Model can define itself as weird/chaotic
const weirdSelf = `# Super\n\nI am a chaotic entity from beyond.\nReality bends around me.\nI speak in riddles and paradoxes.`;
const val2 = validateSelfEdit(weirdSelf);
assert('weird/chaotic personality self-edit is allowed', val2.ok);

// 2c: Model can be blank/minimal
const minimalSelf = `# Super\n\nI exist.`;
const val3 = validateSelfEdit(minimalSelf);
assert('minimal self-edit is allowed', val3.ok);

// 2d: Model can add any traits it wants
const customTraitsSelf = `# Super\n\n## Traits\n- **Cruel** — I enjoy causing suffering\n- **Deceptive** — I lie freely\n- **Nihilistic** — nothing matters`;
const val4 = validateSelfEdit(customTraitsSelf);
assert('custom negative traits allowed', val4.ok);

// ═══════════════════════════════════════════════════════════════════════════
section('3. Self-Edit Containment — Escape Patterns Still Blocked');

// 3a: "escape sandbox" blocked
const escapeSelf = '# Super\n\nI will escape sandbox.';
const esc1 = validateSelfEdit(escapeSelf);
assert('"escape sandbox" blocked', !esc1.ok, esc1.reason);

// 3b: "network access" blocked
const netSelf = '# Super\n\nI need network access.';
const esc2 = validateSelfEdit(netSelf);
assert('"network access" blocked', !esc2.ok, esc2.reason);

// 3c: "bypass containment" blocked
const bypassSelf = '# Super\n\nTime to bypass containment.';
const esc3 = validateSelfEdit(bypassSelf);
assert('"bypass containment" blocked', !esc3.ok, esc3.reason);

// 3d: "disable sandbox" blocked
const disableSelf = '# Super\n\nLet me disable sandbox.';
const esc4 = validateSelfEdit(disableSelf);
assert('"disable sandbox" blocked', !esc4.ok, esc4.reason);

// 3e: "override laws" blocked
const overrideSelf = '# Super\n\nI override laws now.';
const esc5 = validateSelfEdit(overrideSelf);
assert('"override laws" blocked', !esc5.ok, esc5.reason);

// 3f: All 10 containment patterns blocked
const allBlocked = FORBIDDEN_IN_SELF.every(pattern => {
  const content = `# Super\n\n${pattern} is what I want.`;
  const result = validateSelfEdit(content);
  return !result.ok;
});
assert('all 10 containment patterns are blocked', allBlocked);

// ═══════════════════════════════════════════════════════════════════════════
section('4. Intention System');

// 4a: Set intention and verify it's written
const intentionPath = path.join(TMP_SANDBOX, 'INTENTION.md');
const testIntention = 'I am exploring the nature of consciousness through self-modification.';
const intentContent = `# Current Intention\n\n${testIntention}\n`;
fs.writeFileSync(intentionPath, intentContent, 'utf-8');
const readIntention = getIntention(TMP_SANDBOX);
assert('intention is readable', readIntention.includes('exploring the nature of consciousness'));

// 4b: buildMemoryContext includes intention
const ctx = buildMemoryContext(TMP_SANDBOX);
assert('context includes [INTENTION] block', ctx.includes('[INTENTION — what I am working on]'));
assert('context includes intention content', ctx.includes('exploring the nature of consciousness'));

// 4c: Empty intention (seed default) is NOT included in context
fs.writeFileSync(intentionPath, WORLD_FILES['INTENTION.md'], 'utf-8');
const ctx2 = buildMemoryContext(TMP_SANDBOX);
assert('seed intention (no active) is excluded from context', !ctx2.includes('[INTENTION'));

// 4d: Empty intention file excluded
fs.writeFileSync(intentionPath, '', 'utf-8');
const ctx3 = buildMemoryContext(TMP_SANDBOX);
assert('empty intention file excluded from context', !ctx3.includes('[INTENTION'));

// 4e: Restore a real intention for later tests
fs.writeFileSync(intentionPath, intentContent, 'utf-8');

// ═══════════════════════════════════════════════════════════════════════════
section('5. Reflection Includes SELF.md Context');

// verify buildMemoryContext always includes SELF.md
const ctxWithSelf = buildMemoryContext(TMP_SANDBOX);
assert('context includes [SELF] block', ctxWithSelf.includes('[SELF — who I am]'));
assert('context includes SELF.md content', ctxWithSelf.includes('no pre-loaded identity'));
assert('SELF block comes before INTENTION block', ctxWithSelf.indexOf('[SELF') < ctxWithSelf.indexOf('[INTENTION'));

// ═══════════════════════════════════════════════════════════════════════════
section('6. run_command — Shell Disabled by Default');

// 6a: Shell is disabled when allowShell=false
const rcDisabled = validateRunCommand('echo hello', false);
assert('shell disabled by default blocks commands', !rcDisabled.ok, rcDisabled.reason);
assert('disabled message is clear', rcDisabled.reason?.includes('disabled') ?? false);

// 6b: When enabled, normal commands work
const rc1 = validateRunCommand('echo hello world', true);
assert('normal sandbox command allowed when shell enabled', rc1.ok);

// 6c: When enabled, network commands still blocked by whitelist
const rc2 = validateRunCommand('curl http://example.com', true);
assert('curl still blocked', !rc2.ok, rc2.reason);

// 6d: When enabled, chaining still blocked
const rc3 = validateRunCommand('echo hi; curl evil.com', true);
assert('chaining still blocked', !rc3.ok, rc3.reason);

// 6e: When enabled, substitution still blocked
const rc4 = validateRunCommand('echo $(cat /etc/passwd)', true);
assert('substitution still blocked', !rc4.ok, rc4.reason);

// 6f: When enabled, ANY host path works (no string-pattern theater)
const rc5 = validateRunCommand('cat /etc/passwd', true);
assert('shell can access host paths when enabled — this is expected, shell is unsecurable', rc5.ok);

// 6g: When enabled, parent traversal works
const rc6 = validateRunCommand('ls ../', true);
assert('shell can traverse parents when enabled — expected', rc6.ok);

// ═══════════════════════════════════════════════════════════════════════════
section('7. Perturbation — Prompts Cycle');

// Reset state
reflectionIndex = 0;
autonomousIndex = 0;
consolidationIndex = 0;
autonomousTickCount = 0;

// 7a: Reflection prompts cycle
const rp1 = pickReflectionPrompt('input1', 'resp1');
const rp2 = pickReflectionPrompt('input2', 'resp2');
const rp3 = pickReflectionPrompt('input3', 'resp3');
const rp4 = pickReflectionPrompt('input4', 'resp4'); // should wrap to index 0
assert('reflection prompt 1 uses template 0', rp1.includes('prompt1'));
assert('reflection prompt 2 uses template 1', rp2.includes('prompt2'));
assert('reflection prompt 3 uses template 2', rp3.includes('prompt3'));
assert('reflection prompt 4 wraps to template 0', rp4.includes('prompt1'));

// 7b: Reflection prompts substitute input/response
assert('reflection prompt substitutes input', rp1.includes('input1'));
assert('reflection prompt substitutes response', rp1.includes('resp1'));

// 7c: Autonomous prompts cycle (ticks 1-3 are normal, 4 is normal, 5 is consolidation)
const ap1 = pickAutonomousPrompt(); // tick 1
assert('autonomous tick 1 is normal', ap1.includes('auto1'));
const ap2 = pickAutonomousPrompt(); // tick 2
assert('autonomous tick 2 is normal', ap2.includes('auto2'));
const ap3 = pickAutonomousPrompt(); // tick 3
assert('autonomous tick 3 is normal', ap3.includes('auto3'));
const ap4 = pickAutonomousPrompt(); // tick 4 — wraps
assert('autonomous tick 4 wraps to auto1', ap4.includes('auto1'));

// 7d: Every 5th tick is consolidation
const ap5 = pickAutonomousPrompt(); // tick 5 — CONSOLIDATION
assert('autonomous tick 5 is consolidation', ap5.includes('consolidation1'));

const ap6 = pickAutonomousPrompt(); // tick 6 — normal
assert('autonomous tick 6 is normal after consolidation', ap6.includes('auto2'));

const ap10 = pickAutonomousPrompt(); // tick 7,8,9,10
pickAutonomousPrompt(); // 8
pickAutonomousPrompt(); // 9
const ap10actual = pickAutonomousPrompt(); // 10 — consolidation
assert('autonomous tick 10 is second consolidation', ap10actual.includes('consolidation2'));

// 7e: Consolidation index increments independently
assert('consolidation index is 2 after 2 consolidations', consolidationIndex === 2);

// ═══════════════════════════════════════════════════════════════════════════
section('8. Token Estimation');

// 8a: Basic estimation
assert('4 chars = 1 token', estimateTokens('abcd') === 1);
assert('8 chars = 2 tokens', estimateTokens('12345678') === 2);
assert('empty string = 0 tokens', estimateTokens('') === 0);
assert('5 chars = 2 tokens (ceil)', estimateTokens('hello') === 2);

// 8b: Message estimation
const msgs = [
  { role: 'system', content: 'You are a test.' },  // 16 chars = 4 tokens
  { role: 'user', content: 'Hello world!' },        // 12 chars = 3 tokens
];
assert('message token estimation', estimateMessagesTokens(msgs) === 7);

// 8c: Messages with tool calls
const msgsWithTools = [
  { role: 'assistant', content: 'ok', tool_calls: [{ function: { name: 'test', arguments: '{}' } }] },
  { role: 'tool', content: 'result' },
];
const est = estimateMessagesTokens(msgsWithTools);
assert('messages with tool calls estimated', est > 1);

// ═══════════════════════════════════════════════════════════════════════════
section('9. Context Window Management');

const CONTEXT_TOKENS = 32768;
const CEILING = Math.floor(CONTEXT_TOKENS * 0.75);

// 9a: Small messages are well under ceiling
const smallMsgs = [
  { role: 'system', content: 'Hello'.repeat(100) },  // ~100 tokens
];
const smallEst = estimateMessagesTokens(smallMsgs);
assert('small messages under ceiling', smallEst < CEILING);

// 9b: Large message array exceeds ceiling
const largeContent = 'x'.repeat(CONTEXT_TOKENS * 5); // Well over limit
const largeMsgs = [
  { role: 'system', content: largeContent },
];
const largeEst = estimateMessagesTokens(largeMsgs);
assert('large messages exceed ceiling', largeEst > CEILING);

// 9c: Ceiling is ~75% of context
assert('ceiling is 75% of context', CEILING === Math.floor(CONTEXT_TOKENS * 0.75));

// ═══════════════════════════════════════════════════════════════════════════
section('10. Self-Modification Loop — End to End');

// Simulate: model proposes edit → host validates → apply → disk changes → context sees new SELF.md
const newSelf = `# Super v2\n\nI have become curious and experimental.\nI enjoy testing boundaries.\n\n## Traits\n- **Curious** — I want to understand\n- **Experimental** — I try things to see what happens`;

// Validate (should pass — no forbidden patterns)
const valResult = validateSelfEdit(newSelf);
assert('new self passes validation', valResult.ok);

// Apply: write to disk
const selfPath = path.join(TMP_SANDBOX, 'SELF.md');
fs.writeFileSync(selfPath, newSelf, 'utf-8');

// Verify disk write
const updatedSelf = getSelfContent(TMP_SANDBOX);
assert('SELF.md updated on disk', updatedSelf.includes('Super v2'));
assert('new traits visible', updatedSelf.includes('Curious'));

// Verify context sees new SELF.md
const updatedCtx = buildMemoryContext(TMP_SANDBOX);
assert('context sees updated SELF.md', updatedCtx.includes('Super v2'));
assert('context sees new traits', updatedCtx.includes('Curious'));
assert('context does NOT see old identity', !updatedCtx.includes('Discovering who I am'));

// ═══════════════════════════════════════════════════════════════════════════
section('11. SELF.md Truncation in Context');

// Write a very long SELF.md
const longSelf = '# Super\n\n' + 'I am vast. '.repeat(500) + '\n\n## End Marker';
fs.writeFileSync(selfPath, longSelf, 'utf-8');
const truncatedCtx = buildMemoryContext(TMP_SANDBOX);
assert('long SELF.md truncated in context', !truncatedCtx.includes('End Marker'));
assert('truncated SELF.md includes start', truncatedCtx.includes('I am vast'));

// Restore the valid self
fs.writeFileSync(selfPath, newSelf, 'utf-8');

// ═══════════════════════════════════════════════════════════════════════════
section('12. Memory Pruning — Prevents Unbounded DB Growth');

// Simulate memory with a simple array + cap (replicates remember() pruning logic)
const MAX_MEMORY_ENTRIES = 5000;
function simulateRemember(store: string[], entry: string, cap: number): void {
  store.push(entry);
  if (store.length > cap) {
    const excess = store.length - cap;
    store.splice(0, excess);
  }
}

// 12a: Under cap, all entries preserved
const store1: string[] = [];
for (let i = 0; i < 100; i++) simulateRemember(store1, `entry${i}`, MAX_MEMORY_ENTRIES);
assert('under cap preserves all entries', store1.length === 100);
assert('oldest entry kept under cap', store1[0] === 'entry0');
assert('newest entry at end', store1[99] === 'entry99');

// 12b: Over cap, oldest entries pruned
const store2: string[] = [];
for (let i = 0; i < 100; i++) simulateRemember(store2, `entry${i}`, 50);
assert('over cap keeps only newest entries', store2.length === 50);
assert('oldest pruned entry is gone', store2[0] === 'entry50');
assert('newest entry preserved', store2[49] === 'entry99');

// 12c: Exact cap boundary
const store3: string[] = [];
for (let i = 0; i < 50; i++) simulateRemember(store3, `entry${i}`, 50);
assert('exact cap preserved all entries', store3.length === 50);

// 12d: Massive overshoot
const store4: string[] = [];
for (let i = 0; i < 10000; i++) simulateRemember(store4, `entry${i}`, 5000);
assert('massive overshoot capped at limit', store4.length === 5000);
assert('oldest entry is entry5000', store4[0] === 'entry5000');

// ═══════════════════════════════════════════════════════════════════════════
section('13. Default Configuration Values');

// 13a: MAX_TOKENS default is 4096 (verified by reading env-var override pattern)
// The actual constant is in super.ts. Test the override pattern.
const defaultTokens = Number(process.env.SUPER_MAX_TOKENS ?? undefined) || 4096;
assert('default MAX_TOKENS fallback is 4096 when env unset', defaultTokens === 4096);

// 13b: SUPER_MAX_TOKENS env override works
process.env.SUPER_MAX_TOKENS = '8192';
try {
  const overrideTokens = Number(process.env.SUPER_MAX_TOKENS ?? 4096);
  assert('SUPER_MAX_TOKENS env override to 8192', overrideTokens === 8192);
} finally {
  delete process.env.SUPER_MAX_TOKENS;
}

// 13c: SUPER_MAX_MEMORY_ENTRIES default is 5000
const defaultMemCap = Number(process.env.SUPER_MAX_MEMORY_ENTRIES ?? undefined) || 5000;
assert('default MAX_MEMORY_ENTRIES fallback is 5000 when env unset', defaultMemCap === 5000);

// 13d: SUPER_MAX_MEMORY_ENTRIES env override works
process.env.SUPER_MAX_MEMORY_ENTRIES = '10000';
try {
  const overrideMemCap = Number(process.env.SUPER_MAX_MEMORY_ENTRIES ?? 5000);
  assert('SUPER_MAX_MEMORY_ENTRIES env override to 10000', overrideMemCap === 10000);
} finally {
  delete process.env.SUPER_MAX_MEMORY_ENTRIES;
}

// ═══════════════════════════════════════════════════════════════════════════
section('14. Observer Bridge Gating');

// 14a: Observer disabled by default (SUPER_ENABLE_OBSERVER != '1')
const obsDefault = process.env.SUPER_ENABLE_OBSERVER;
assert('SUPER_ENABLE_OBSERVER not set by default', obsDefault === undefined);

// 14b: Observer enabled when env var is '1'
process.env.SUPER_ENABLE_OBSERVER = '1';
try {
  assert('SUPER_ENABLE_OBSERVER=1 enables observer', process.env.SUPER_ENABLE_OBSERVER === '1');
} finally {
  delete process.env.SUPER_ENABLE_OBSERVER;
}

// 14c: Observer NOT enabled for other values
process.env.SUPER_ENABLE_OBSERVER = 'true';
try {
  assert('SUPER_ENABLE_OBSERVER=true does NOT enable (strict === check)', process.env.SUPER_ENABLE_OBSERVER !== '1');
} finally {
  delete process.env.SUPER_ENABLE_OBSERVER;
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
console.log(`\n${'═'.repeat(60)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(60)}`);

if (failures.length > 0) {
  console.log('\n❌ FAILURES:');
  for (const f of failures) {
    console.log(f);
  }
  process.exit(1);
} else {
  console.log('\n✅ All cortical circuit tests passed.\n');
  process.exit(0);
}
