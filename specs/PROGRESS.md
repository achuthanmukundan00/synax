# Progress Log

Use this file as a living record of planned-version execution. Add entries in reverse chronological order.

## Entry Template

Date: YYYY-MM-DD

Version/phase:

Completed:

Verification run:

Decisions made:

Blockers:

Next step:

## 2026-05-05

Version/phase: v0.7 daily-driver safety, iteration 4 of 5

Completed:

- Added a patch approval callback to the runner for previewed replacement edits.
- Rejected previewed replacement edits without writing when the approval decision is `reject`.
- Made non-interactive `synax run --task` reject previewed replacement edits by default and accept them only with `--yes`.
- Updated command/safety docs, the v0.7 spec, and learnings with the explicit run approval policy.

Verification run:

- `npm test -- runner.test.ts -t "rejects a previewed edit" --runInBand`: failed first on missing `approvePatch`, then passed after implementation.
- `npm test -- run-task.test.ts --runInBand`: failed first because non-interactive run still applied the edit, then passed after wiring `--yes`.
- `npx prettier --write src/agent/runner.ts src/agent/run-task.ts src/commands/run.ts src/__tests__/runner.test.ts src/__tests__/run-task.test.ts README.md docs/guide/commands.md docs/guide/safety-context.md specs/004-v0.7-daily-driver-safety.md specs/LEARNINGS.md`: passed.
- `npm test -- runner.test.ts run-task.test.ts --runInBand`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 15 suites and 196 tests.
- `npm run build`: passed.
- `npm run docs:build`: passed.

Decisions made:

- Kept approval scoped to validated replacement edits, not file creation.
- Preserved the direct runner default as accept so existing programmatic callers keep current behavior unless they opt into approval.
- Used `--yes` as the non-interactive accept signal instead of adding a prompt loop to `run`.

Blockers:

- Git metadata writes are blocked in this sandbox (`.git/index.lock`: Operation not permitted), so the required commit could not be created here.

Next step:

- Prove replacement patch application is atomic or fails without partial file writes.

## 2026-05-05

Version/phase: v0.6 extension kernel + MCP bridge groundwork, iteration 3 of 5

Completed:

- Added `createBuiltinExtensions()` as an explicit internal built-in extension wiring point.
- Wired built-in tool-call parsing, no-op repair/sanitization placeholders, OpenAI-compatible provider adapter construction, local docs provider, verification runner, renderer factories, model-facing tools, and guarded MCP bridge groundwork through that registry.
- Added a no-network extension test proving the built-ins are available through the wiring and that guarded MCP import rejects unsafe tool policy while runtime import remains unsupported.
- Updated maintainer docs and the v0.6 spec with the built-in wiring status.

Verification run:

- `npm test -- extensions.test.ts --runInBand`: failed first on missing `createBuiltinExtensions`, then passed after implementation.
- `npx prettier --write src/extensions/builtins.ts src/extensions/index.ts src/__tests__/extensions.test.ts docs/guide/development.md specs/003-v0.6-extension-kernel-mcp-groundwork.md`: passed.
- `npm run typecheck`: passed.
- `npm test -- extensions.test.ts --runInBand`: passed.
- `npm test`: passed, 14 suites and 194 tests.
- `npm run build`: passed.
- `npm run docs:build`: passed.

Decisions made:

- Kept the registry internal and explicit, with no global mutable plugin state and no CLI behavior changes.
- Kept MCP runtime import unsupported; the bridge only exports native tool metadata and rejects unsafe import policies for now.
- Used no-op repair and reasoning sanitizer placeholders so future v0.4/v0.6 work has a named wiring point without changing current output behavior.

Blockers:

- Git metadata writes are blocked in this sandbox (`.git/index.lock`: Operation not permitted), so the required commit could not be created here.

Next step:

- Add broader MCP safety-boundary tests for approval/checkpoint policy, verification policy, and context budgets, or replace the current unsupported import stub with a guarded implementation if runtime MCP import is explicitly selected.

## 2026-05-05

Version/phase: v0.5 self-hosting docs + spec execution, iteration 2 of 5

Completed:

- Exposed the bounded local docs provider through `synax inspect --docs` and `synax inspect --doc <path>`.
- Added a CLI smoke test covering docs listing, bounded doc reads, and existing bearer-token redaction.
- Documented the inspect docs commands in README and VitePress command docs.
- Updated the v0.5 spec and learnings log with the inspect docs exposure behavior.

Verification run:

- `npm test -- cli.test.ts -t "should expose local docs listing" --runInBand`: failed first on unknown `--docs`, then passed after implementation.
- `npx prettier --write src/commands/inspect.ts src/__tests__/cli.test.ts docs/guide/commands.md README.md specs/002-v0.5-self-hosting-docs-spec-execution.md specs/LEARNINGS.md`: passed.
- `npm run typecheck`: passed.
- `npm test -- cli.test.ts -t "should expose local docs listing" --runInBand`: passed.
- `npm test`: passed, 14 suites and 193 tests.
- `npm run build`: passed.
- `npm run docs:build`: passed.

Decisions made:

- Chose the highest-priority remaining v0.5 task by exposing the existing provider through `inspect`, rather than starting plan execution or model-facing tools.
- Kept the read surface single-file and bounded by the existing `readLocalDoc` defaults.
- Supported `--json` for the new docs inspect outputs because `inspect` already has JSON mode.
- Did not add docs search, docs-impact checks, or self-hosting workflow docs in this iteration.

Blockers:

- Git metadata writes are blocked in this sandbox (`.git/index.lock`: Operation not permitted), so the required commit could not be created here.

Next step:

- Add deterministic docs search over recognized local docs using filenames, headings, and bounded text search.

## 2026-05-05

Version/phase: v0.4 tool-call survival, iteration 1 of 5

Completed:

- Wired typed parser failures into the OpenAI-compatible LLM client instead of relying on legacy array-returning parser helpers.
- Rejected malformed native `message.tool_calls[*].function.arguments` before the runner can treat the response as a final answer.
- Preserved the existing exported array-returning parser helpers for current callers.
- Documented that malformed tool-call JSON surfaces as `model_error`.
- Updated the v0.4 spec and learnings log with the runtime parser-failure behavior.

Verification run:

- `npm test -- llm-client.test.ts --runInBand`: failed first as expected before the fix, then passed.
- `npm test -- tool-calls.test.ts --runInBand`: passed.
- `npx prettier --write src/llm/tool-calls.ts src/llm/client.ts src/__tests__/llm-client.test.ts`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 14 suites and 192 tests.
- `npm run build`: passed.
- `npm run docs:build`: passed.

Decisions made:

- Kept this iteration scoped to malformed parser failure propagation only.
- Did not add reasoning-tag sanitization, unknown-tool rejection, ambiguity policy, provider diagnostics, or a broader parser fixture suite.
- Used a plain model-output error from the LLM client so existing runner error handling reports a `model_error`.
- Avoided repo-wide formatting because pre-existing dirty chat files were unrelated to this task.

Blockers:

- Git metadata writes are blocked in this sandbox (`.git/index.lock`: Operation not permitted), so the required commit could not be created here.

Next step:

- Add reasoning/thinking tag sanitization before tool parsing and final answer rendering, or implement unknown/ambiguous tool-call rejection with focused fixtures.

## 2026-05-05

Version/phase: spec status refresh

Completed:

- Updated all five numbered specs from draft-style planning docs into current in-progress trackers.
- Added current-state and remaining-work sections for v0.4, v0.5, v0.6, v0.7, and v1.0.
- Split completed acceptance items from remaining release-gating work where the prior checklists were stale.
- Added a roadmap execution snapshot so the work-left summary is visible from the top-level planning doc.

Verification run:

- `npm run docs:build`: passed.

Decisions made:

- Kept verification checkboxes open where a final milestone or release pass still needs to be rerun.
- Treated prior successful verification runs as historical progress evidence, not as proof that unfinished milestones are currently complete.
- Did not edit runtime code or the existing modified chat files.

Blockers:

- None for the planning-doc refresh.

Next step:

- Resume implementation with v0.4 runtime-wide parser failure handling or v0.7 accept/reject behavior, depending on priority.

## 2026-05-05

Version/phase: v1.0 local coding agent runtime, iteration 5

Completed:

- Added a public compatibility report format in the VitePress docs.
- Added an initial compatibility matrix that distinguishes design targets from verified smoke-test results.
- Linked the compatibility page from the docs nav/sidebar and README.
- Marked the compatibility report acceptance item in the v1.0 spec.

Verification run:

- `npm run typecheck`: passed.
- `npm run docs:build`: passed.

Decisions made:

- Kept this iteration docs-only because the selected spec allows the matrix to begin as a docs table.
- Did not add a generated `doctor` report, new CLI behavior, dependencies, package version changes, or unverified compatibility claims.
- Used `not tested`, `unknown`, and assumption-labeled rows so local model support is not overstated.

Blockers:

- Git metadata writes are blocked in this sandbox, so the required commit could not be created here.

Next step:

- Add a generated compatibility/diagnostic report to `doctor --full`, or record a real local Relay smoke report when a compatible endpoint is available.

## 2026-05-05

Version/phase: v0.7 daily-driver safety, iteration 4

Completed:

- Added a shared patch preview data shape for validated replacement edits.
- Emitted a `patch_preview` event after validation and before applying an edit.
- Surfaced patch previews in run diagnostics and agent renderers.
- Documented current patch preview behavior and its non-interactive limitation.

Verification run:

- `npm run format`: passed.
- `npm test -- runner.test.ts`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 14 suites and 188 tests.
- `npm run build`: passed.
- `npm run docs:build`: passed.

Decisions made:

- Kept this iteration scoped to preview visibility only.
- Did not add accept/reject prompting, undo, checkpoints, worktree mode, run logs, or repair loops.
- Reused the existing replacement validation path so previews are only emitted for edits Synax is about to apply.

Blockers:

- Git metadata writes are blocked in this sandbox, so the required commit could not be created here.

Next step:

- Add accept/reject behavior on top of the preview event, with explicit non-interactive `run` semantics.

## 2026-05-05

Version/phase: v0.6 extension kernel + MCP bridge groundwork, iteration 3

Completed:

- Added documented internal TypeScript extension interfaces for tool-call parsing, tool-call repair, reasoning sanitization, provider adapters, context providers, verification, docs providers, renderers, and MCP bridge groundwork.
- Added a compile-oriented unit test proving the interface surface can describe current built-in seams without global runtime plugin state.
- Documented the internal extension interface stance for maintainers.

Verification run:

- `npm run format`: passed.
- `npm test -- extensions.test.ts`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 14 suites and 187 tests.
- `npm run build`: passed.
- `npm run docs:build`: passed.

Decisions made:

- Kept this iteration scoped to interface definitions only.
- Did not add a registry, runtime MCP bridge behavior, dependencies, or public CLI behavior.
- Modeled MCP import policy with Synax's existing `ToolSafetyPolicy` so future imported tools must declare policy metadata explicitly.

Blockers:

- Git metadata writes are blocked in this sandbox, so the required commit could not be created here.

Next step:

- Add minimal built-in extension wiring or registry tests while preserving current CLI behavior.

## 2026-05-05

Version/phase: v0.5 self-hosting docs + spec execution, iteration 2

Completed:

- Added an internal local docs provider that discovers bounded project documentation/spec/config-example files.
- Added bounded docs reads with line numbers and secret redaction.
- Added tests covering README, AGENTS.md, CHANGELOG.md, docs, specs, config examples, generated VitePress output exclusion, bounded reads, and non-doc read rejection.

Verification run:

- `npm run format`: passed.
- `npm run typecheck`: passed.
- `npm test -- docs-provider.test.ts`: passed.
- `npm test`: passed, 13 suites and 186 tests.
- `npm run build`: passed.
- `npm run docs:build`: passed.

Decisions made:

- Kept this iteration scoped to provider discovery/read behavior only.
- Did not expose new CLI or model tool behavior yet, so public docs were not changed.
- Reused the existing repository path policy and secret redaction helpers.

Blockers:

- Git metadata writes are blocked in this sandbox, so the required commit could not be created here.

Next step:

- Wire the local docs provider into an inspect or model-facing command/tool path, then document only the exposed behavior.

## 2026-05-05

Version/phase: v0.4 tool-call survival, iteration 1

Completed:

- Added an explicit typed tool-call parser result API around the existing native OpenAI and assistant-content parser paths.
- Preserved the existing array-returning parser functions for current agent/client callers.
- Added parser-focused tests covering a typed OpenAI success result and a typed malformed `<tool_call>` failure.

Verification run:

- `npm run typecheck`: passed.
- `npm test`: passed, 12 suites and 183 tests.
- `npm run build`: passed.

Decisions made:

- Kept this iteration scoped to parser result typing and malformed `<tool_call>` diagnostics.
- Did not wire failure results into agent execution yet, so current runtime behavior remains compatible.

Blockers:

- Git metadata writes are blocked in this sandbox, so the required commit could not be created here.

Next step:

- Wire parser failure results into the LLM client or agent runner so malformed and ambiguous tool calls fail closed with visible diagnostics.

## 2026-05-05

Version/phase: v0.4-v1.0 planning scaffold

Completed:

- Created planning/spec scaffold for v0.4 through v1.0 development.
- Added PRD, roadmap, reusable spec template, detailed milestone specs, progress log, and learnings log.
- Updated agent operating guidance to emphasize local-model tool-call survival.

Verification run:

- `npm test`: passed, 11 suites and 181 tests.
- `npm run build`: passed.
- `npm run docs:build`: passed.

Decisions made:

- Treat v0.4 as Tool-Call Survival before broader agent-parity work.
- Keep v1.1 Intelligent Compaction as a post-v1 milestone.
- Keep specs practical and future-tense so planned behavior is not confused with implemented behavior.

Blockers:

- None known for the scaffold itself.

Next step:

- Execute [001-v0.4-tool-call-survival.md](001-v0.4-tool-call-survival.md) with tests and docs.
