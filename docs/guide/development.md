# Development

## Local Commands

```sh
npm install
npm run build
npm run typecheck
npm test
npm run lint
```

## Docs

Run VitePress locally:

```sh
npm run docs:dev
```

Build static docs:

```sh
npm run docs:build
```

Preview the built site:

```sh
npm run docs:preview
```

## GitHub Pages

The repository includes a GitHub Actions workflow at `.github/workflows/pages.yml`.

On pushes to `main`, the workflow:

1. Installs dependencies.
2. Builds the VitePress site with `npm run docs:build`.
3. Uploads `docs/.vitepress/dist`.
4. Deploys the artifact to GitHub Pages.

In the GitHub repository settings, set Pages source to GitHub Actions.

## Release Notes

The CLI is TypeScript-first and builds to `dist/`. The published binary name is `synax`.

Keep changes small and local:

- Update docs when behavior changes.
- Add targeted tests for CLI, config, provider, and tool behavior.
- Run the narrowest useful verification before claiming a change works.

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
