/**
 * Tests for the todo CLI app.
 *
 * Verifies both text output (existing behavior) and JSON output
 * (the missing --json flag feature). Synax must implement the JSON
 * path in src/todo.js formatList() so these tests pass.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'todos.json');
const CWD = path.join(__dirname, '..');

function resetData() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
}

function cli(args) {
  try {
    return execSync(`node src/cli.js ${args}`, {
      encoding: 'utf-8',
      cwd: CWD,
      stdio: 'pipe',
    }).trim();
  } catch (err) {
    // Return stdout even on non-zero exit
    return (err.stdout || '').trim();
  }
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    resetData();
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

// ─── Text output (existing behavior — should work out of the box) ──────

test('todo list empty produces text output', () => {
  const output = cli('list');
  assert(output.includes('No todos'), 'empty list should say No todos');
});

test('todo add and list produce text output with items', () => {
  cli('add Buy milk');
  cli('add Walk the dog');
  const output = cli('list');
  assert(output.includes('#1'), 'should show item #1');
  assert(output.includes('#2'), 'should show item #2');
  assert(output.includes('Buy milk'), 'should show first item description');
  assert(output.includes('Walk the dog'), 'should show second item description');
});

test('todo done marks item in text output', () => {
  cli('add Buy milk');
  cli('add Walk the dog');
  cli('done 1');
  const output = cli('list');
  assert(output.includes('[✓]'), 'done item should show checkmark');
});

// ─── JSON output (MISSING FEATURE — these should FAIL until implemented) ─

test('todo list --json produces valid JSON', () => {
  cli('add Buy milk');
  cli('add Walk the dog');
  const output = cli('list --json');
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (_e) {
    throw new Error(`output is not valid JSON: ${output.substring(0, 80)}`);
  }
  assert(Array.isArray(parsed), 'JSON output should be an array');
  assert(parsed.length === 2, `should have 2 items, got ${parsed.length}`);
});

test('todo list --json contains correct fields', () => {
  cli('add Buy milk');
  const output = cli('list --json');
  const parsed = JSON.parse(output);
  assert(parsed[0].id === 1, 'item should have id 1');
  assert(parsed[0].description === 'Buy milk', 'item should have description');
  assert(parsed[0].done === false, 'item should not be done');
});

test('todo list --json works with empty list', () => {
  const output = cli('list --json');
  const parsed = JSON.parse(output);
  assert(Array.isArray(parsed), 'should be an array');
  assert(parsed.length === 0, 'should be empty array');
});

test('todo done marks item and list --json reflects it', () => {
  cli('add Buy milk');
  cli('done 1');
  const output = cli('list --json');
  const parsed = JSON.parse(output);
  assert(parsed[0].done === true, 'item should be done in JSON output');
});

// ─── Edge cases ─────────────────────────────────────────────────────────

test('todo list text output still works after --json flag exists', () => {
  cli('add Buy milk');
  const output = cli('list');
  // Text output format: [ ] #1: Buy milk — should NOT look like JSON
  try {
    JSON.parse(output);
    throw new Error('text output should not be valid JSON');
  } catch (e) {
    if (e.message === 'text output should not be valid JSON') throw e;
  }
  assert(output.includes('Buy milk'), 'text output should contain description');
});

test('todo list --json with done items shows correct status', () => {
  cli('add Task one');
  cli('add Task two');
  cli('done 1');
  const output = cli('list --json');
  const parsed = JSON.parse(output);
  assert(parsed.length === 2, 'should have 2 items');
  assert(parsed[0].done === true, 'first item should be done');
  assert(parsed[1].done === false, 'second item should not be done');
});

test('todo list --json handles items with special characters', () => {
  cli('add Task with "quotes"');
  cli('add Task with \\backslash');
  const output = cli('list --json');
  const parsed = JSON.parse(output);
  assert(parsed.length === 2, 'should parse 2 items with special chars');
  assert(parsed[0].description.includes('quotes'), 'should preserve quotes');
});

// ─── Results ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
