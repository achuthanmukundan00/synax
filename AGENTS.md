# Synax

Instructions for AI coding agents working in this repository.

## Mission

Synax is the de-facto coding agent for devs running local models on consumer GPUs.

Synax is a TypeScript-first, CLI-first, local-first coding agent for developers using Relay or another OpenAI-compatible local inference gateway. It is the compatibility-and-control layer between messy local inference and real software work.

Do not treat Synax as a cloud agent platform, SaaS product, IDE, web dashboard, database-backed memory system, or generic automation framework.

## Current Strategic Priority

v0.4 focuses on local-model tool-call survival:

- robust local-model tool-call parsing
- Qwen/Unsloth GGUF, llama.cpp, and Relay compatibility
- reasoning/thinking tag sanitization
- malformed structured-output recovery
- provider/model compatibility diagnostics
- tests and docs proving the behavior

Do not chase generic agent parity before fixing local model reliability. Local models often emit malformed tool calls, invalid JSON, leaked reasoning tags, mixed final answers, provider quirks, and constrained-runtime behavior. Synax should survive those cases safely before adding broader agent features.

## Ralph Wiggum Operating Mode

Be small, literal, and careful:

1. Inspect before editing.
2. Make the smallest correct patch.
3. Avoid broad refactors.
4. Do not add dependencies unless clearly necessary.
5. Update docs when public behavior changes.
6. Run relevant verification before claiming success.
7. Report files changed, tests run, and remaining risks.

If a task is ambiguous, prefer a conservative, inspectable change over an ambitious redesign.

## Hard Rules

- Use TypeScript.
- Do not introduce Rust.
- Do not introduce Python services.
- Do not introduce a database.
- Do not introduce Docker infrastructure unless explicitly requested.
- Do not add a web UI unless explicitly requested.
- Do not add cloud-only assumptions.
- Do not require OpenAI-hosted APIs for normal local use.
- Do not add large dependencies without a clear reason.
- Do not make unrelated cleanup changes.
- Do not refactor architecture unless explicitly requested.
- Do not claim verification passed unless you ran it.
- Do not silently skip failed verification.
- Do not blindly load the whole repository into context.

## Product Constraints

Synax must remain:

- CLI-first
- local-first
- Relay-compatible
- small enough to understand
- usable with constrained local models
- careful with context usage
- deterministic where practical

Prefer boring, inspectable control flow over clever agent behavior.

## Naming

Use `Synax` for the product name in prose.

Use `synax` for the CLI command, npm package name, binary name, config filenames, code identifiers, and examples.

Examples:

```sh
synax run --task "fix the failing test"
synax chat
```

## Repository Shape

Current source layout:

```txt
src/
  agent/
  commands/
  config/
  llm/
  tools/
  __tests__/
```

VitePress docs live under `docs/`. Planning specs live under `specs/`.

Prefer private modules and explicit exports. Avoid large files; if a file grows past roughly 500 LoC, prefer adding a focused module instead of extending it further.

## Repo Commands

Discovered from `package.json`:

```sh
npm run build          # tsc
npm run typecheck      # tsc --noEmit
npm run lint           # eslint . --ext .ts
npm run lint:fix       # eslint . --ext .ts --fix
npm run format         # prettier --write "src/**/*.ts"
npm run format:check   # prettier --check "src/**/*.ts"
npm test               # jest
npm run test:verbose   # jest --verbose
npm run docs:dev       # vitepress dev docs
npm run docs:build     # vitepress build docs
npm run docs:preview   # vitepress preview docs
npm run synax -- ...   # node dist/cli.js
```

Run only commands relevant to the change. For docs-only changes, `npm test`, `npm run build`, and `npm run docs:build` are usually enough when reasonable.

## Current CLI Facts

The human-facing docs in `README.md` and `docs/guide/*.md` are the source of truth for current behavior. As of this scaffold:

- Commands include `chat`, `ask`, `run`, `inspect`, `config`, and `doctor`.
- `synax run --plan plan.md` is documented as a placeholder, not implemented behavior.
- Bash is disabled by default.
- Synax loads built-in defaults, optional global config at `~/.config/synax/config.toml`, and nearest project `.synax.toml`.
- Relay/local OpenAI-compatible endpoints are the preferred inference path.

Do not document planned features as implemented.

## Context Rules

Context is a budget.

Do not load large files without a reason. Never read these paths unless explicitly relevant:

```txt
node_modules/
.git/
dist/
build/
coverage/
.next/
.cache/
.vite/
docs/.vitepress/dist/
*.lock
package-lock.json
pnpm-lock.yaml
yarn.lock
```

Prefer this inspection sequence:

1. Inspect `package.json`.
2. Inspect project tree.
3. Inspect relevant files only.
4. Inspect nearby tests.
5. Inspect docs/specs if behavior changes.

For large files, read targeted sections only.

## Coding Conventions

- Use strict TypeScript.
- Prefer explicit return types on exported functions.
- Use discriminated unions for structured states.
- Keep provider logic isolated under `src/llm/`.
- Keep tool input/output shapes explicit and compact.
- Keep CLI rendering separate from core logic where practical.
- Do not log API keys or full prompts by default.
- Fail clearly with actionable errors.

## Testing Conventions

Prefer targeted tests. Check `package.json` before choosing verification commands.

For CLI changes, prefer smoke tests that exercise the actual CLI path. For config changes, test missing config, defaults, explicit config, and invalid config. For LLM/tool-call changes, test request shaping and parser behavior without requiring a live model server unless the repo already has a live smoke test.

Recommended verification order after code changes:

1. `npm run format` if editing formatted TypeScript.
2. `npm run typecheck`
3. targeted tests or `npm test`
4. `npm run build`
5. `npm run docs:build` when docs changed

## Synax Self-Development

When modifying Synax itself:

- Inspect the relevant tests and nearby runtime files before editing.
- Change the smallest viable code path.
- Prefer hardening existing behavior over adding new abstractions.
- Update docs only when behavior changes.
- Run `npm run typecheck` before claiming success.
- Run targeted tests when available, then broader verification if the change touches public behavior.
- Summarize changed files, verification status, and any remaining gaps in the final response.

Do not ask before running normal project-local verification commands.

## Documentation

Update docs when behavior changes. Docs should be direct and operational:

- install
- run
- configure
- Relay setup
- model/base URL options
- known limitations
- verification commands

Keep `AGENTS.md` imperative for coding agents. Keep `README.md` and `docs/` human-facing.

## Specs

Use `specs/000-template.md` for future implementation specs. Keep `specs/PROGRESS.md` and `specs/LEARNINGS.md` current when completing planned phases or learning new local-model compatibility facts.

## Default Stance

Prefer small, correct, local, inspectable changes.

Synax should feel like a sharp CLI tool for local model users, not a bloated assistant framework.
