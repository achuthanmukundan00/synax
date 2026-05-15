#!/usr/bin/env bun
/**
 * score-synax-benchmark.mjs — Deterministic scorer for Synax benchmark runs.
 *
 * Reads artifacts from a completed benchmark run directory and produces
 * a score.json with component scores and a weighted total.
 *
 * Usage:
 *   bun scripts/score-synax-benchmark.mjs <artifacts-dir>
 *
 * Scored dimensions (each 0–1, with configurable weight):
 *   - testPassRate       (0–1)  Portion of tests passing. Max weight.
 *   - allTestsPass       (0/1)  1 if all tests pass, else 0.
 *   - finalAnswer        (0/1)  1 if Synax produced a non-empty final answer.
 *   - noTimeout          (0/1)  1 if Synax did not time out.
 *   - filesChanged       (0/1)  1 if Synax changed at least one source file.
 *   - readBeforeEdit     (0/1)  1 if transcript shows read before write/edit.
 *   - toolErrorRate      (0–1)  1 if no tool errors, decreasing with errors.
 *   - cleanExit          (0/1)  1 if Synax exited cleanly (code 0).
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Weights (must sum to 1) ─────────────────────────────────
const WEIGHTS = {
  testPassRate: 0.30,
  allTestsPass: 0.20,
  noTimeout: 0.15,
  filesChanged: 0.10,
  finalAnswer: 0.05,
  readBeforeEdit: 0.10,
  toolErrorRate: 0.05,
  cleanExit: 0.05,
};

// ─── Main ────────────────────────────────────────────────────

function main() {
  const artifactsDir = process.argv[2];
  if (!artifactsDir) {
    console.error('Usage: bun score-synax-benchmark.mjs <artifacts-dir>');
    process.exit(1);
  }

  if (!existsSync(artifactsDir)) {
    console.error(`Artifacts directory not found: ${artifactsDir}`);
    process.exit(1);
  }

  const components = scoreAll(artifactsDir);
  const { total, breakdown } = computeTotal(components);

  const score = {
    total: Math.round(total * 100) / 100,
    totalRaw: total,
    breakdown,
    weights: WEIGHTS,
    scoredAt: new Date().toISOString(),
    artifactsDir,
  };

  const scorePath = join(artifactsDir, 'score.json');
  writeFileSync(scorePath, JSON.stringify(score, null, 2), 'utf-8');
  console.log(`[scorer] Score written to ${scorePath}`);
  console.log(`[scorer] Total: ${score.total}`);
  console.log(`[scorer] Breakdown: ${JSON.stringify(breakdown)}`);
}

// ─── Score individual dimensions ────────────────────────────

function scoreAll(artifactsDir) {
  const meta = readJson(join(artifactsDir, 'meta.json'));
  const transcript = readFile(join(artifactsDir, 'transcript.txt'));
  const testOutput = readFile(join(artifactsDir, 'test-output.txt'));
  const gitDiff = readFile(join(artifactsDir, 'git-diff.txt'));
  const gitStatus = readFile(join(artifactsDir, 'git-status.txt'));
  const testExitCode = readFile(join(artifactsDir, 'test-exit-code.txt')).trim();

  // --- testPassRate ---
  // Parse test output for PASS/FAIL counts
  const testResult = parseTestOutput(testOutput);
  const testPassRate = testResult.total > 0 ? testResult.passed / testResult.total : 0;

  // --- allTestsPass ---
  const allTestsPass = testResult.failed === 0 && testResult.total > 0 ? 1 : 0;

  // --- noTimeout ---
  const noTimeout = meta.timedOut ? 0 : 1;

  // --- filesChanged ---
  // Check if git diff shows changes to source files (not just .synax.toml etc.)
  const filesChanged = detectSourceFileChanges(gitDiff, gitStatus) ? 1 : 0;

  // --- finalAnswer ---
  const hasFinalAnswer = transcriptIncludesFinalAnswer(transcript) ? 1 : 0;

  // --- readBeforeEdit ---
  const readBeforeEdit = detectReadBeforeEdit(transcript) ? 1 : 0;

  // --- toolErrorRate ---
  const toolErrorCount = countToolErrors(transcript);
  const toolErrorRate = Math.max(0, 1 - toolErrorCount * 0.1);

  // --- cleanExit ---
  const cleanExit = meta.synaxExitCode === 0 ? 1 : 0;

  return {
    testPassRate,
    allTestsPass,
    noTimeout,
    filesChanged,
    finalAnswer: hasFinalAnswer,
    readBeforeEdit,
    toolErrorRate: Math.round(toolErrorRate * 100) / 100,
    cleanExit,
    metadata: {
      testPassed: testResult.passed,
      testFailed: testResult.failed,
      testTotal: testResult.total,
      testExitCode,
      timedOut: meta.timedOut || false,
      synaxExitCode: meta.synaxExitCode,
      durationSeconds: meta.durationSeconds,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function readFile(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Parse test output to extract pass/fail counts.
 * Expected format from test/validate-email.test.js:
 *   "N passed, M failed, T total"
 */
function parseTestOutput(output) {
  const match = output.match(/(\d+)\s+passed,\s*(\d+)\s+failed,\s*(\d+)\s+total/);
  if (match) {
    return {
      passed: parseInt(match[1], 10),
      failed: parseInt(match[2], 10),
      total: parseInt(match[3], 10),
    };
  }
  // Fallback: count individual PASS/FAIL lines
  const passCount = (output.match(/PASS:/g) || []).length;
  const failCount = (output.match(/FAIL:/g) || []).length;
  const total = passCount + failCount;
  return { passed: passCount, failed: failCount, total };
}

/**
 * Check if Synax changed any source files (not just .synax.toml, bun.lock, etc.)
 */
function detectSourceFileChanges(gitDiff, gitStatus) {
  // git diff shows actual changes
  if (gitDiff.trim().length > 0) {
    // Check if changes are in source files, not just config
    const diffLines = gitDiff.split('\n');
    for (const line of diffLines) {
      if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
        const filePath = line.replace(/^[+-]{3} [ab]\//, '');
        if (isSourceFile(filePath)) return true;
      }
    }
  }
  // Fallback: git status shows modified files
  if (gitStatus.includes('modified:') || gitStatus.includes('new file:')) {
    const statusLines = gitStatus.split('\n');
    for (const line of statusLines) {
      if ((line.includes('modified:') || line.includes('new file:')) && isSourceFile(line)) {
        return true;
      }
    }
  }
  return false;
}

function isSourceFile(path) {
  const nonSource = ['.synax.toml', 'bun.lock', 'node_modules', '.git'];
  return !nonSource.some((p) => path.includes(p));
}

/**
 * Check if the transcript shows evidence of read-before-edit behavior.
 * Synax's activities include "read" or "file_read" before "write" or "edit".
 */
function detectReadBeforeEdit(transcript) {
  const lines = transcript.split(/\r?\n/);
  let sawRead = false;

  for (const line of lines) {
    const lower = line.toLowerCase();

    const isRead =
      /\[synax\]\s+tool:\s+read\b/i.test(line) ||
      /\btool:\s*read\b/i.test(line) ||
      /"toolname"\s*:\s*"read"/i.test(line) ||
      lower.includes("read_before_edit");

    if (isRead) {
      sawRead = true;
      continue;
    }

    const isEdit =
      /\[synax\]\s+tool:\s+(edit|write|patch)\b/i.test(line) ||
      /\btool:\s*(edit|write|patch)\b/i.test(line) ||
      /"toolname"\s*:\s*"(edit|write|patch)"/i.test(line);

    if (isEdit) {
      return sawRead;
    }
  }

  // If no edit happened, do not award this dimension. The benchmark expects edits.
  return false;
}

/**
 * Check if Synax produced a non-empty final answer.
 */
function transcriptIncludesFinalAnswer(transcript) {
  // Synax prints "Final:" followed by the answer (or "(none)" if empty)
  const finalSection = transcript.match(/Final:\s*\n([\s\S]*?)(?:\n\n|\n\[synax\]|\n════|$)/);
  if (finalSection && finalSection[1].trim() && finalSection[1].trim() !== '(none)') {
    return true;
  }

  // Also check for terminal state "completed" with a meaningful final answer
  if (transcript.includes('terminal state: completed') || transcript.includes('Status: completed')) {
    return true;
  }

  return false;
}

/**
 * Count tool errors in the transcript.
 * Looks for error patterns from Synax tool execution.
 */
function countToolErrors(transcript) {
  let count = 0;

  // Tool error patterns
  const patterns = [
    /tool_error/i,
    /tool call.*error/i,
    /malformed tool call/i,
    /failed_verification/i,
    /tool.*failed/i,
    /execution error/i,
    /EACCES/i,
    /ENOENT/i,
  ];

  for (const pattern of patterns) {
    const matches = transcript.match(new RegExp(pattern.source, 'gi'));
    if (matches) count += matches.length;
  }

  // Cap at a reasonable maximum (10 errors = score 0)
  return Math.min(count, 10);
}

// ─── Compute weighted total ─────────────────────────────────

function computeTotal(components) {
  const { testPassRate, allTestsPass, noTimeout, filesChanged, finalAnswer, readBeforeEdit, toolErrorRate, cleanExit } =
    components;

  let total = 0;
  total += testPassRate * WEIGHTS.testPassRate;
  total += allTestsPass * WEIGHTS.allTestsPass;
  total += noTimeout * WEIGHTS.noTimeout;
  total += filesChanged * WEIGHTS.filesChanged;
  total += finalAnswer * WEIGHTS.finalAnswer;
  total += readBeforeEdit * WEIGHTS.readBeforeEdit;
  total += toolErrorRate * WEIGHTS.toolErrorRate;
  total += cleanExit * WEIGHTS.cleanExit;

  const breakdown = {
    testPassRate,
    allTestsPass,
    noTimeout,
    filesChanged,
    finalAnswer,
    readBeforeEdit,
    toolErrorRate,
    cleanExit,
  };

  return { total, breakdown };
}

// ─── Run ─────────────────────────────────────────────────────
main();
