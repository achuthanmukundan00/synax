# Build v0.1 acceptance demo and regression fixtures

GitHub labels: `type:test`, `area:acceptance`, `priority:p1`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/11

Local spec mirror: `docs/specs/011-v01-acceptance-demo.md`

## Problem

The requirements need executable proof. Without a demo and regression fixtures, v0.1 can drift into claims instead of behavior.

## Scope

Create acceptance fixtures and scripts that prove the v0.1 journey.

## Requirements

- Provide a small TypeScript demo repository or fixture with one known failing test.
- Demonstrate read-only tracing with cited file ranges and context ledger output.
- Demonstrate small patch flow: inspect, ledger, patch, diff, confirm, apply, verify, report.
- Demonstrate safe failures: malformed model output, unread-file patch, replacement no-match/multi-match, verification failure, provider failure, context budget exceeded.
- Document how to run the demo with Relay or another OpenAI-compatible local endpoint.

## Acceptance Criteria

- A maintainer can run the acceptance demo from a clean checkout.
- Demo output visibly includes the context ledger.
- Patch demo changes only inspected files.
- Verification command is bounded and reported.
- Failure fixtures are deterministic.

## Out Of Scope

- Benchmarking against cloud agents.
- Model fine-tuning.
- Hosted SaaS demo.
