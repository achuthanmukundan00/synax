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
