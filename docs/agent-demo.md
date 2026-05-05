# Synax v0.2 — Agent Demo Guide

- **Tool Registry & Inspection** — Synax maintains a discoverable registry of available tools and exposes their signatures so agents can inspect capabilities before use.
- **Context Ledger** — Every agent interaction is recorded in an append-only context ledger, providing full auditability and replay of the decision trail.
- **Read-Only Ask Flow** — When an operation requires human approval or external input, Synax enters a read-only ask state rather than guessing or auto-proceeding.
- **Patch Application Flow** — Proposed changes are staged as atomic patches that can be reviewed, diffed, and applied only after explicit acceptance.
- **Verification & Failure States** — Synax runs post-application verification checks and cleanly surfaces failure states so agents can recover without corrupting the repository.
