# Implement tool registry and deterministic read-only inspection tools

GitHub labels: `type:feature`, `area:tools`, `area:inspection`, `priority:p0`

GitHub issue: https://github.com/achuthanmukundan00/synax/issues/5

Local spec mirror: `docs/specs/005-tool-registry-and-inspection-tools.md`

## Problem

Weak local models need narrow, explicit tools. If tools are vague or unbounded, the model will wander, over-read, or propose unsafe edits.

## Scope

Implement the v0.1 tool registry and deterministic read-only repo inspection tools.

## Requirements

- Define a tool interface with name, description, input schema, safety policy, execution function, result shape, and ledger behavior.
- Implement minimum tools: `list_files`, `read_file_range`, `search_text`, `show_git_status`, `show_git_diff`.
- Prefer repo-relative paths.
- Reject generated, binary, vendor, secret, and env files unless policy allows them.
- Bound command output and file ranges.
- Track which files and line ranges have been inspected.
- Make tool descriptions explicit enough for weaker local models.

## Acceptance Criteria

- Each tool validates input before execution.
- `read_file_range` returns bounded line-numbered output.
- `search_text` returns bounded matches with file paths and line numbers.
- `show_git_status` and `show_git_diff` are read-only and ledger-visible.
- Inspection state can answer whether a file was inspected before patching.

## Out Of Scope

- Symbol search unless trivial after core tools exist.
- Arbitrary shell command execution.
- MCP/ACP tool integration.
