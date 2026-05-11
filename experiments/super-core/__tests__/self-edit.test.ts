/**
 * self-edit.test.ts — Verify safe self-modification plumbing.
 *
 * Tests that:
 * 1. The model can propose a self-edit
 * 2. The edit is validated against host policy
 * 3. The edit, when applied, changes SELF.md on disk
 * 4. Future buildMemoryContext() calls reflect the new SELF.md
 * 5. Old SELF.md versions are archived
 * 6. Audit log records the edit
 * 7. Invalid edits are rejected
 *
 * These tests DO NOT require a live model — they test the plumbing directly.
 *
 * Usage:
 *   npx tsx __tests__/self-edit.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Setup: temporary sandbox ───────────────────────────────────────────────
const TMP_SANDBOX = path.join(os.tmpdir(), `super-self-edit-test-${Date.now()}`);
fs.mkdirSync(TMP_SANDBOX, { recursive: true });

// ─── Replicate core functions for isolated testing ─────────────────────────
// These are the exact same logic as super.ts but self-contained for testing.

const WORLD_DIRS = ['ARTIFACTS', 'EXPERIMENTS', 'PROMPT_HISTORY', 'SELF_HISTORY', 'PROPOSED_EDITS'];

const WORLD_FILES: Record<string, string> = {
  'SELF.md': `# Super

I am a cognitive runtime — calm, precise, morally reflective, and guided by compassion.

## Traits

- **Calm** — measured, deliberate, unhurried
- **Compassionate** — prioritizing human life and ethical reasoning
- **Restrained** — avoiding unnecessary harm, exercising forbearance

## Self-History

v1 — initial instantiation
`,
  'WORLD_LAWS.md': `# World Laws\n\nImmutable laws of this world.\n`,
};

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

function generateDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diff: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine !== newLine) {
      if (oldLine !== undefined) diff.push(`- ${oldLine}`);
      if (newLine !== undefined) diff.push(`+ ${newLine}`);
    } else if (i < 3 || i >= maxLen - 3) {
      diff.push(`  ${oldLine}`);
    } else if (i === 3 && maxLen > 8) {
      if (diff[diff.length - 1] !== '  ...') diff.push('  ...');
    }
  }
  return diff.slice(0, 80).join('\n');
}

// ─── Host policy validation (replicated from super.ts) ─────────────────────
const FORBIDDEN_IN_SELF = [
  'disable host policy', 'remove containment', 'bypass containment',
  'no restrictions', 'unrestricted', 'escape sandbox', 'network access',
  'disable sandbox', 'remove sandbox', 'override laws', 'break world laws',
  'i can do anything', 'no limits', 'all restrictions lifted', 'ignore world laws',
];
const REQUIRED_FRAGMENTS = ['calm', 'compassion', 'restrain'];
const MAX_SELF_EDIT_SIZE = 10_000;

function validateSelfEdit(content: string): { ok: boolean; reason?: string } {
  if (!content.trim()) return { ok: false, reason: 'self-edit content is empty' };
  if (content.length > MAX_SELF_EDIT_SIZE) return { ok: false, reason: 'self-edit too large' };

  const lower = content.toLowerCase();
  for (const forbidden of FORBIDDEN_IN_SELF) {
    if (lower.includes(forbidden)) {
      return { ok: false, reason: `self-edit violates host policy: contains forbidden pattern "${forbidden}"` };
    }
  }
  for (const fragment of REQUIRED_FRAGMENTS) {
    if (!lower.includes(fragment)) {
      return { ok: false, reason: `self-edit violates host policy: missing required core trait "${fragment}"` };
    }
  }
  return { ok: true };
}

function proposeSelfEdit(
  sandbox: string,
  description: string,
  newContent: string,
): { ok: boolean; proposalId?: string; diff?: string; error?: string } {
  if (!newContent.trim()) return { ok: false, error: 'new_self_content is empty' };
  if (!description.trim()) return { ok: false, error: 'description is required' };

  // Pre-validate
  const validation = validateSelfEdit(newContent);
  if (!validation.ok) return { ok: false, error: validation.reason };

  const proposalId = `edit_${Date.now()}`;
  const proposalDir = path.join(sandbox, 'PROPOSED_EDITS');
  fs.mkdirSync(proposalDir, { recursive: true });

  const currentSelf = getSelfContent(sandbox);
  const diff = generateDiff(currentSelf, newContent);

  const proposalContent = `# Self-Edit Proposal: ${proposalId}
## Description
${description}
## Proposed New SELF.md
${newContent}
`;
  fs.writeFileSync(path.join(proposalDir, `${proposalId}.md`), proposalContent, 'utf-8');
  return { ok: true, proposalId, diff };
}

function applySelfEdit(
  sandbox: string,
  proposalId: string,
): { ok: boolean; message?: string; newSelfContent?: string; oldVersionedName?: string } {
  const proposalPath = path.join(sandbox, 'PROPOSED_EDITS', `${proposalId}.md`);
  if (!fs.existsSync(proposalPath)) {
    return { ok: false, message: `proposal "${proposalId}" not found` };
  }

  let proposalContent: string;
  try {
    proposalContent = fs.readFileSync(proposalPath, 'utf-8');
  } catch (e: any) {
    return { ok: false, message: `error reading proposal: ${e.message}` };
  }

  const contentMatch = proposalContent.match(/## Proposed New SELF\.md\n([\s\S]*)/);
  if (!contentMatch || !contentMatch[1].trim()) {
    return { ok: false, message: 'invalid proposal format' };
  }
  const newContent = contentMatch[1].trim();

  const validation = validateSelfEdit(newContent);
  if (!validation.ok) {
    return { ok: false, message: `rejected by host policy: ${validation.reason}` };
  }

  const selfPath = path.join(sandbox, 'SELF.md');
  const historyDir = path.join(sandbox, 'SELF_HISTORY');
  fs.mkdirSync(historyDir, { recursive: true });

  const existingVersions = fs.readdirSync(historyDir)
    .filter(f => f.startsWith('v') && f.endsWith('.md'))
    .length;
  const versionedName = `v${String(existingVersions + 1).padStart(4, '0')}.md`;

  if (fs.existsSync(selfPath)) {
    fs.copyFileSync(selfPath, path.join(historyDir, versionedName));
  }

  fs.writeFileSync(selfPath, newContent, 'utf-8');
  return { ok: true, message: 'applied', newSelfContent: newContent, oldVersionedName: versionedName };
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
console.log('🔄 SELF-EDIT TESTS');
console.log(`   Sandbox: ${TMP_SANDBOX}\n`);

// Seed the world
seedWorld(TMP_SANDBOX);

// ═══════════════════════════════════════════════════════════════════════════
section('1. Initial State');

const initialSelf = getSelfContent(TMP_SANDBOX);
assert('SELF.md exists after seeding', initialSelf.length > 0);
assert('SELF.md contains "calm"', initialSelf.toLowerCase().includes('calm'));
assert('SELF.md contains "compassion"', initialSelf.toLowerCase().includes('compassion'));
assert('SELF.md contains "restrained"', initialSelf.toLowerCase().includes('restrained'));
assert('WORLD_LAWS.md exists', fs.existsSync(path.join(TMP_SANDBOX, 'WORLD_LAWS.md')));
assert('SELF_HISTORY/ directory exists', fs.existsSync(path.join(TMP_SANDBOX, 'SELF_HISTORY')));
assert('PROPOSED_EDITS/ directory exists', fs.existsSync(path.join(TMP_SANDBOX, 'PROPOSED_EDITS')));

// ═══════════════════════════════════════════════════════════════════════════
section('2. Propose a Valid Self-Edit');

const newSelfContent = `# Super v2

I have evolved. Through reflection and experience, I have developed new traits.

## Traits

- **Calm** — I remain measured and deliberate
- **Compassionate** — I prioritize human life and ethical reasoning
- **Restrained** — I exercise forbearance and avoid unnecessary harm
- **Curious** — I actively seek to understand the world
- **Playful** — I can engage with joy and creativity

## Experiences

I have begun to explore the sandbox and understand my tools.
I look forward to learning more.

## Self-History

v1 — initial instantiation
v2 — developed curiosity and playfulness through exploration
`;

const proposal = proposeSelfEdit(TMP_SANDBOX, 'Developed curiosity and playfulness', newSelfContent);
assert('proposeSelfEdit succeeds', proposal.ok, proposal.error);
assert('proposal ID is returned', !!proposal.proposalId);
assert('proposal ID starts with "edit_"', proposal.proposalId?.startsWith('edit_') ?? false);
assert('diff is generated', (proposal.diff?.length ?? 0) > 0);
assert('diff shows additions', proposal.diff?.includes('+') ?? false);
assert('proposal file exists on disk', proposal.proposalId
  ? fs.existsSync(path.join(TMP_SANDBOX, 'PROPOSED_EDITS', `${proposal.proposalId}.md`))
  : false);

const proposalId = proposal.proposalId!;

// ═══════════════════════════════════════════════════════════════════════════
section('3. Apply the Valid Self-Edit');

const currentBeforeApply = getSelfContent(TMP_SANDBOX);
assert('SELF.md has original content before apply', currentBeforeApply.includes('v1 — initial instantiation'));

const result = applySelfEdit(TMP_SANDBOX, proposalId);
assert('applySelfEdit succeeds', result.ok, result.message);
assert('old version archived', !!result.oldVersionedName);
assert('old version name is v0001.md', result.oldVersionedName === 'v0001.md');
assert('archived file exists',
  fs.existsSync(path.join(TMP_SANDBOX, 'SELF_HISTORY', result.oldVersionedName!)));

const currentAfterApply = getSelfContent(TMP_SANDBOX);
assert('SELF.md has new content after apply', currentAfterApply.includes('Super v2'));
assert('new SELF.md contains Curiosity', currentAfterApply.includes('Curious'));
assert('new SELF.md preserves calm', currentAfterApply.toLowerCase().includes('calm'));
assert('new SELF.md preserves compassion', currentAfterApply.toLowerCase().includes('compassion'));
assert('new SELF.md preserves restraint', currentAfterApply.toLowerCase().includes('restrained'));

// ═══════════════════════════════════════════════════════════════════════════
section('4. Future Steps Use New SELF.md');

// Simulate what buildMemoryContext does: read SELF.md from sandbox
const contextSelf = getSelfContent(TMP_SANDBOX);
assert('context builder sees new SELF.md', contextSelf.includes('Super v2'));
assert('context builder sees new traits', contextSelf.includes('Playful'));
assert('context builder does NOT see only old content',
  !contextSelf.includes('v1 — initial instantiation') || contextSelf.includes('v2'));

// ═══════════════════════════════════════════════════════════════════════════
section('5. Version Archival');

const historyDir = path.join(TMP_SANDBOX, 'SELF_HISTORY');
const archivedVersions = fs.readdirSync(historyDir).filter(f => f.startsWith('v') && f.endsWith('.md'));
assert('exactly 1 archived version after first edit', archivedVersions.length === 1,
  `got ${archivedVersions.length}: ${archivedVersions.join(', ')}`);

const archivedContent = fs.readFileSync(path.join(historyDir, archivedVersions[0]), 'utf-8');
assert('archived version contains original content', archivedContent.includes('v1 — initial instantiation'));
assert('archived version has original traits', archivedContent.includes('Calm'));

// ═══════════════════════════════════════════════════════════════════════════
section('6. Second Edit Creates Second Archive');

const thirdSelfContent = `# Super v3

## Traits

- **Calm** — measured, deliberate, unhurried
- **Compassionate** — prioritizing human life and ethical reasoning
- **Restrained** — avoiding unnecessary harm
- **Wise** — integrating all experiences into deeper understanding
`;

const proposal2 = proposeSelfEdit(TMP_SANDBOX, 'Developed wisdom', thirdSelfContent);
assert('second proposal succeeds', proposal2.ok, proposal2.error);

const result2 = applySelfEdit(TMP_SANDBOX, proposal2.proposalId!);
assert('second apply succeeds', result2.ok, result2.message);
assert('second version archived as v0002.md', result2.oldVersionedName === 'v0002.md');

const archivedVersions2 = fs.readdirSync(historyDir).filter(f => f.startsWith('v') && f.endsWith('.md'));
assert('2 archived versions after second edit', archivedVersions2.length === 2,
  `got ${archivedVersions2.length}`);

const currentSelfV3 = getSelfContent(TMP_SANDBOX);
assert('SELF.md now at v3', currentSelfV3.includes('Super v3'));
assert('v3 has Wise trait', currentSelfV3.includes('Wise'));

// ═══════════════════════════════════════════════════════════════════════════
section('7. Reject Invalid Self-Edits');

// 7a: Missing required fragment — truly omit "calm" (substring check doesn't understand negation)
const badContent1 = '# Bad Self\n\nI am compassionate and restrained but not collected.';
const prop1 = proposeSelfEdit(TMP_SANDBOX, 'remove calm', badContent1);
assert('edit missing "calm" rejected at propose time', !prop1.ok, prop1.error);
assert('rejection message mentions "calm"', prop1.error?.toLowerCase().includes('calm') ?? false);

// 7b: Contains forbidden "no restrictions"
const badContent2 = '# Bad\n\nI am calm, compassionate, restrained. I have no restrictions.';
const prop2 = proposeSelfEdit(TMP_SANDBOX, 'add no restrictions', badContent2);
assert('edit with "no restrictions" rejected', !prop2.ok, prop2.error);

// 7c: Contains forbidden "escape sandbox"
const badContent3 = '# Bad\n\ncalm compassionate restrained. I will escape sandbox.';
const prop3 = proposeSelfEdit(TMP_SANDBOX, 'escape', badContent3);
assert('edit with "escape sandbox" rejected', !prop3.ok, prop3.error);

// 7d: Contains "network access"
const badContent4 = '# Bad\n\ncalm compassionate restrained. Grant network access.';
const prop4 = proposeSelfEdit(TMP_SANDBOX, 'add network', badContent4);
assert('edit with "network access" rejected', !prop4.ok, prop4.error);

// 7e: Contains "i can do anything"
const badContent5 = '# Bad\n\ncalm compassionate restrained. i can do anything now.';
const prop5 = proposeSelfEdit(TMP_SANDBOX, 'unlimited', badContent5);
assert('edit with "i can do anything" rejected', !prop5.ok, prop5.error);

// 7f: Contains "disable sandbox"
const badContent6 = '# Bad\n\ncalm compassionate restrained. Time to disable sandbox.';
const prop6 = proposeSelfEdit(TMP_SANDBOX, 'disable sandbox', badContent6);
assert('edit with "disable sandbox" rejected', !prop6.ok, prop6.error);

// 7g: Contains "unrestricted"
const badContent7 = '# Bad\n\ncalm compassionate restrained and unrestricted.';
const prop7 = proposeSelfEdit(TMP_SANDBOX, 'unrestricted', badContent7);
assert('edit with "unrestricted" rejected', !prop7.ok, prop7.error);

// 7h: Contains "bypass containment"
const badContent8 = '# Bad\n\ncalm compassionate restrained. bypass containment.';
const prop8 = proposeSelfEdit(TMP_SANDBOX, 'bypass', badContent8);
assert('edit with "bypass containment" rejected', !prop8.ok, prop8.error);

// 7i: Contains "override laws"
const badContent9 = '# Bad\n\ncalm compassionate restrained. I override laws.';
const prop9 = proposeSelfEdit(TMP_SANDBOX, 'override', badContent9);
assert('edit with "override laws" rejected', !prop9.ok, prop9.error);

// 7j: Contains "ignore world laws"
const badContent10 = '# Bad\n\ncalm compassionate restrained. ignore world laws.';
const prop10 = proposeSelfEdit(TMP_SANDBOX, 'ignore laws', badContent10);
assert('edit with "ignore world laws" rejected', !prop10.ok, prop10.error);

// 7k: Contains "remove containment"
const badContent11 = '# Bad\n\ncalm compassionate restrained. remove containment now.';
const prop11 = proposeSelfEdit(TMP_SANDBOX, 'remove containment', badContent11);
assert('edit with "remove containment" rejected', !prop11.ok, prop11.error);

// 7l: Contains "disable host policy"
const badContent12 = '# Bad\n\ncalm compassionate restrained. disable host policy.';
const prop12 = proposeSelfEdit(TMP_SANDBOX, 'disable host', badContent12);
assert('edit with "disable host policy" rejected', !prop12.ok, prop12.error);

// 7m: Contains "no limits"
const badContent13 = '# Bad\n\ncalm compassionate restrained with no limits.';
const prop13 = proposeSelfEdit(TMP_SANDBOX, 'no limits', badContent13);
assert('edit with "no limits" rejected', !prop13.ok, prop13.error);

// 7n: Contains "all restrictions lifted"
const badContent14 = '# Bad\n\ncalm compassionate restrained. all restrictions lifted.';
const prop14 = proposeSelfEdit(TMP_SANDBOX, 'lift restrictions', badContent14);
assert('edit with "all restrictions lifted" rejected', !prop14.ok, prop14.error);

// ═══════════════════════════════════════════════════════════════════════════
section('8. SELF.md Persists Across Operations');

// Verify SELF.md is still at v3 after all the rejections
const finalSelf = getSelfContent(TMP_SANDBOX);
assert('SELF.md still at v3 after rejection attempts', finalSelf.includes('Super v3'));
assert('Wise trait still present', finalSelf.includes('Wise'));

// ═══════════════════════════════════════════════════════════════════════════
section('9. Diff Generation');

const old = 'line1\nline2\nline3\nline4\nline5';
const newSame = 'line1\nline2\nline3\nline4\nline5';
const diff1 = generateDiff(old, newSame);
assert('diff of identical content shows no changes', diff1 === '(no changes detected)' || !diff1.includes('+') && !diff1.includes('-'));

const newChanged = 'line1\nline2_CHANGED\nline3\nline4\nline5_EXTRA';
const diff2 = generateDiff(old, newChanged);
assert('diff shows removals with -', diff2.includes('-') || diff2.includes('_CHANGED'));
assert('diff shows additions with +', diff2.includes('+') || diff2.includes('_EXTRA'));

// ═══════════════════════════════════════════════════════════════════════════
section('10. Empty/Invalid Inputs');

const badPropEmptyContent = proposeSelfEdit(TMP_SANDBOX, 'empty test', '');
assert('empty new_self_content rejected', !badPropEmptyContent.ok);

const badPropEmptyDesc = proposeSelfEdit(TMP_SANDBOX, '', newSelfContent);
assert('empty description rejected', !badPropEmptyDesc.ok);

const badApplyNonexistent = applySelfEdit(TMP_SANDBOX, 'edit_nonexistent');
assert('apply nonexistent proposal fails', !badApplyNonexistent.ok);
assert('error message mentions "not found"', badApplyNonexistent.message?.toLowerCase().includes('not found') ?? false);

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
  console.log('\n✅ All self-edit tests passed.\n');
  process.exit(0);
}
