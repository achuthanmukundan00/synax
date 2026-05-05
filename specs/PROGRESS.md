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
