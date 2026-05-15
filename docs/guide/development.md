# Development

## Local Commands

```sh
bun install
bun run build
bun run typecheck
bun run test
bun run lint
```

## Docs

Run VitePress locally:

```sh
bun run docs:dev
```

Build static docs:

```sh
bun run docs:build
```

Preview the built site:

```sh
bun run docs:preview
```

## GitHub Pages

The repository includes a GitHub Actions workflow at `.github/workflows/pages.yml`.

On pushes to `main`, the workflow:

1. Installs dependencies.
2. Builds the VitePress site with `bun run docs:build`.
3. Uploads `docs/.vitepress/dist`.
4. Deploys the artifact to GitHub Pages.

In the GitHub repository settings, set Pages source to GitHub Actions.

## Release Notes

The CLI is TypeScript-first and builds to `dist/`. The published binary name is `synax`.

Keep changes small and local:

- Update docs when behavior changes.
- Add targeted tests for CLI, config, provider, and tool behavior.
- Run the narrowest useful verification before claiming a change works.

## Self-Development Guardrails

When using Synax to modify Synax:

- Inspect the relevant tests before editing.
- Update the smallest code path that can satisfy the change.
- Keep docs changes tied to behavior changes.
- Run `bun run typecheck` after edits.
- Run targeted tests when they exist, then the broader verification set if the change affects public behavior.
- Summarize changed files and verification status at the end of the run.

## Smoke Tests

These are the preferred bounded smoke checks for self-development work:

Read-only:

```sh
bun run synax -- run --mode read-only --task "Inspect the command registry and identify one safe improvement. Do not modify files."
```

Patch:

```sh
bun run synax -- run --mode patch --task "Make one minimal docs-only wording improvement in README.md, then run bun run typecheck."
```

Verification:

```sh
bun run synax -- run --mode verify --task "Inspect the recent patch and report whether verification looks safe to run."
```

Manual checks:

```sh
bun run synax -- inspect
bun run synax -- doctor --full
```

## Verification Requirements

Run and pass these commands before landing behavior changes:

```sh
bun run test
bun run typecheck
bun run build
bun run docs:build
```

## Extension Interfaces

Synax keeps extension seams internal and explicit. The stable interface definitions live in `src/extensions/` and cover:

- tool-call parsing and bounded repair
- reasoning/thinking sanitization
- provider adapters
- context and docs providers
- verification runners
- event renderers
- guarded MCP bridge groundwork

These interfaces are maintainer contracts, not a plugin marketplace. Runtime wiring should stay explicit, testable without network access, and unable to bypass tool policy, verification policy, approval/checkpoint policy, or context budgets.

Built-in extension wiring lives in `src/extensions/builtins.ts`. It is an internal registry for current built-ins only: tool-call parsing, no-op repair/sanitization placeholders, OpenAI-compatible provider construction, local docs, verification, CLI renderers, model-facing tools, and guarded MCP bridge groundwork. The MCP import path deliberately rejects unsafe policies and otherwise reports unsupported until a real runtime bridge exists.
