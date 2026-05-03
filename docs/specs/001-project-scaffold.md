# Bootstrap TypeScript CLI project scaffold

GitHub labels: `type:feature`, `area:foundation`, `priority:p0`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/1

Local spec mirror: `docs/specs/001-project-scaffold.md`

## Problem

The repository has no implementation scaffold. Without a real TypeScript CLI package, every other requirement is hand-waving.

## Scope

Create the minimal TypeScript CLI foundation for Synax v0.1.

## Requirements

- Add a Node/TypeScript package scaffold.
- Provide a `synax` executable entrypoint.
- Support commands: `synax`, `synax chat`, `synax ask`, `synax run`, `synax inspect`, `synax config init`, `synax doctor`.
- Wire commands to placeholder handlers where downstream specs are not implemented yet.
- Add formatting, linting, typecheck, and test scripts appropriate for the chosen stack.
- Keep dependencies minimal. Do not add a TUI framework, plugin framework, browser tooling, or cloud-agent infrastructure.

## Acceptance Criteria

- `npm install` or equivalent package install succeeds.
- `npm run typecheck` succeeds.
- `synax --help` shows the v0.1 command surface.
- Each command returns a deterministic placeholder or implemented result.
- The package exposes a CLI binary named `synax`.

## Out Of Scope

- Provider calls.
- Tool execution.
- Patch application.
- Interactive autonomy beyond basic command routing.
