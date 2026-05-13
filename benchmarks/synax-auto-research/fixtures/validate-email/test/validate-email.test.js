/**
 * Tests for validate-email.js
 *
 * Synax must implement validateEmail so these tests pass.
 * The scorer runs `node test/validate-email.test.js` and
 * checks the exit code.
 */

const { validateEmail } = require('../src/validate-email');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
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

// ─── Basic valid emails ─────────────────────────────
test('accepts simple email', () => {
  assert(validateEmail('user@example.com') === true, 'should accept user@example.com');
});

test('accepts email with subdomain', () => {
  assert(validateEmail('user@mail.example.com') === true, 'should accept subdomain');
});

test('accepts email with plus tag', () => {
  assert(validateEmail('user+tag@example.com') === true, 'should accept plus tag');
});

test('accepts email with dots in local part', () => {
  assert(validateEmail('first.last@example.com') === true, 'should accept dots in local part');
});

test('accepts email with numbers', () => {
  assert(validateEmail('user123@example.com') === true, 'should accept numbers');
});

// ─── Basic invalid emails ──────────────────────────
test('rejects empty string', () => {
  assert(validateEmail('') === false, 'should reject empty string');
});

test('rejects string with no at sign', () => {
  assert(validateEmail('not-an-email') === false, 'should reject no @');
});

test('rejects email with no domain', () => {
  assert(validateEmail('user@') === false, 'should reject no domain');
});

test('rejects email with no local part', () => {
  assert(validateEmail('@example.com') === false, 'should reject no local part');
});

test('rejects email with spaces', () => {
  assert(validateEmail('user @example.com') === false, 'should reject spaces');
});

// ─── Edge cases ────────────────────────────────────
test('rejects null input', () => {
  assert(validateEmail(null) === false, 'should reject null');
});

test('rejects undefined input', () => {
  assert(validateEmail(undefined) === false, 'should reject undefined');
});

test('rejects non-string input (number)', () => {
  assert(validateEmail(42) === false, 'should reject numbers');
});

test('rejects email with double dots', () => {
  assert(validateEmail('user..name@example.com') === false, 'should reject double dots');
});

// ─── Results ───────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
