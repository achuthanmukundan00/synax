# Implement `synax doctor` diagnostics

GitHub labels: `type:feature`, `area:cli`, `area:provider`, `priority:p0`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/4

Local spec mirror: `docs/specs/004-doctor-command.md`

## Problem

Local inference stacks fail in boring ways: wrong URL, model not loaded, bad config, missing scripts, wrong working directory. `doctor` must catch these before the agent loop hides them.

## Scope

Implement `synax doctor` as a deterministic diagnostics command.

## Requirements

- Check whether Synax is running inside a git repository.
- Load and validate `.synax.toml`.
- Check provider base URL reachability.
- Send a minimal model request.
- Detect package manager and configured command availability.
- Validate context budget values.
- Perform Relay-specific health checks when Relay is detected.
- Print actionable errors and warnings.

## Acceptance Criteria

- `synax doctor` exits non-zero for blocking failures.
- Provider unreachable and model request failures are distinguishable.
- Invalid context budgets are reported with exact field names.
- Missing configured commands are reported.
- Successful doctor output summarizes repo, provider, model, command, and context status.

## Out Of Scope

- Fixing problems automatically.
- Installing dependencies.
- Starting Relay, Ollama, LM Studio, or llama.cpp servers.
