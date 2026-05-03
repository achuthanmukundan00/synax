# Implement context ledger with visible budgets and truncation markers

GitHub labels: `type:feature`, `area:context-ledger`, `priority:p0`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/6

Local spec mirror: `docs/specs/006-context-ledger.md`

## Problem

The context ledger is the differentiator. Without it, Synax becomes another local wrapper around Chat Completions.

## Scope

Implement a context ledger for every model call.

## Requirements

- Track instruction sources included.
- Track project instruction files included, summarized, omitted, or truncated.
- Track user task.
- Track file paths and line ranges included.
- Track command outputs included.
- Track summaries.
- Track omitted and truncated materials.
- Track approximate token usage and remaining context budget.
- Show compact ledger by default and support expanded output on demand.
- Enforce conservative defaults from the requirements document.

## Acceptance Criteria

- Every model call has a ledger entry.
- Compact ledger output includes instructions, files, commands, budget, and truncation state.
- Truncation is never silent.
- Approximate input token usage is visible.
- Ledger can be shown before and after model calls.

## Out Of Scope

- Perfect tokenizer parity with every local model.
- Long-term memory.
- Complex context optimization beyond selected ranges, summaries, and truncation markers.
