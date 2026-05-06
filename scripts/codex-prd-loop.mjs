#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const maxIterations = parseMaxIterations(process.argv[2]);
const specFiles = listImplementationSpecs();

if (maxIterations > specFiles.length) {
  throw new Error(
    `max_iterations (${maxIterations}) exceeds available implementation specs (${specFiles.length})`,
  );
}

for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
  const specFile = specFiles[iteration - 1];
  console.log(`[codex-prd-loop] iteration ${iteration}/${maxIterations}: ${specFile}`);

  const prd = readRequiredFile('specs/PRD.md');
  const progress = readRequiredFile('specs/PROGRESS.md');
  const spec = readRequiredFile(specFile);
  const prompt = buildPrompt({ iteration, maxIterations, prd, progress, specFile, spec });

  runCodex(prompt);
}

function parseMaxIterations(rawValue) {
  if (!rawValue) {
    throw new Error('Usage: node scripts/codex-prd-loop.mjs <max_iterations>');
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`max_iterations must be a positive integer; received ${JSON.stringify(rawValue)}`);
  }

  return parsed;
}

function readRequiredFile(relativePath) {
  const absolutePath = resolve(repoRoot, relativePath);
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read ${relativePath}: ${error.message}`);
  }
}

function listImplementationSpecs() {
  return readdirSync(resolve(repoRoot, 'specs'))
    .filter((fileName) => /^\d{3}-.+\.md$/.test(fileName))
    .filter((fileName) => fileName !== '000-template.md')
    .sort()
    .map((fileName) => `specs/${fileName}`);
}

function buildPrompt({ iteration, maxIterations, prd, progress, specFile, spec }) {
  return `You are running inside the Synax repository.

This is iteration ${iteration} of ${maxIterations}. Work on exactly one task, then stop.

Use the embedded PRD, progress log, and selected spec below as planning context:

<PRD path="specs/PRD.md">
${prd}
</PRD>

<PROGRESS path="specs/PROGRESS.md">
${progress}
</PROGRESS>

<SELECTED_SPEC path="${specFile}">
${spec}
</SELECTED_SPEC>

Task selection:
- Treat ${specFile} as the selected spec for this iteration.
- Pick the single highest-priority unfinished task from that selected spec and current progress.
- If the selected spec appears fully complete, record that in specs/PROGRESS.md and stop without starting another spec.
- Do not start multiple tasks.

Execution rules:
- Inspect before editing.
- Keep the patch minimal and scoped.
- Do not add dependencies unless truly necessary.
- Do not change package version unless the selected task explicitly requires release work.
- Update docs if public behavior changes.
- Run relevant verification.
- Update specs/PROGRESS.md with the completed task, verification run, decisions, blockers, and next step.
- Make exactly one git commit for the completed task.

Final response:
- Summarize the selected task, files changed, verification, commit hash, and any risks.
- If no suitable task can be completed, explain why and do not commit.
`;
}

function runCodex(prompt) {
  const result = spawnSync(
    'codex',
    ['exec', '--cd', repoRoot, '--sandbox', 'workspace-write'],
    {
      cwd: repoRoot,
      input: prompt,
      stdio: ['pipe', 'inherit', 'inherit'],
      encoding: 'utf8',
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`codex exec failed with exit code ${result.status}`);
  }
}
