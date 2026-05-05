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
