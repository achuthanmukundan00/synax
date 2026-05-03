# Implement strict `replace_in_file` patch proposal and application flow

GitHub labels: `type:feature`, `area:patching`, `area:safety`, `priority:p0`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/8

Local spec mirror: `docs/specs/008-patch-application-flow.md`

## Problem

Patch safety is the other core differentiator. v0.1 should choose a simple edit primitive that local models can reliably produce and Synax can validate.

## Scope

Implement edit-capable patch proposal and application using `replace_in_file`.

## Requirements

- Use `replace_in_file(path, old_str, new_str)` as the v0.1 edit primitive.
- Require target files to have been inspected before patch proposal/application.
- Require `old_str` to match exactly once unless explicitly allowed.
- Reject edits to unread files.
- Reject generated/vendor/env/secret file edits unless explicitly approved by policy.
- Reject unrelated files, broad refactors, and changes exceeding configured change budget.
- Show diff before application.
- Require user confirmation by default.
- Detect dirty working tree conflicts before applying.

## Acceptance Criteria

- Patch proposals touching unread files are rejected with exact file names.
- No-match and multi-match replacements are rejected.
- Diff is shown before application.
- User confirmation gate is enforced by default.
- Applied patches preserve unrelated content and formatting.

## Out Of Scope

- Unified diff patching.
- Multi-file refactors by default.
- Auto-apply mode except through explicit future config.
