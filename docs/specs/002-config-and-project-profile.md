# Implement `.synax.toml` config and project profile detection

GitHub labels: `type:feature`, `area:config`, `area:foundation`, `priority:p0`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/2

Local spec mirror: `docs/specs/002-config-and-project-profile.md`

## Problem

Synax cannot be strict or inspectable until it knows the repository, configuration, command policy, and project basics.

## Scope

Implement local project configuration and lightweight repository profiling.

## Requirements

- Support `.synax.toml` in the repository root.
- Implement `synax config init` to create a starter config without overwriting an existing file unless explicitly confirmed.
- Detect git root, current branch, dirty working tree status, package manager, likely language ecosystem, available package scripts, and likely test/typecheck/lint commands.
- Detect project instruction files: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.clinerules`, `README.md`, `.synax.md`.
- Do not blindly load large instruction files into model context. Return metadata and summaries/selective inclusion hooks only.
- Implement `synax inspect` to show the project profile, detected commands, config summary, and git status.

## Acceptance Criteria

- Running outside a git repository produces an actionable error.
- Running in a git repository shows root, branch, dirty status, package manager, and command candidates.
- `.synax.toml` is parsed with validation and clear errors.
- `synax config init` creates the recommended default config.
- Dirty working tree state is visible before edit-capable flows.

## Out Of Scope

- Global config.
- Secrets management beyond avoiding env/secret file edits.
- Automatic dependency installation.
