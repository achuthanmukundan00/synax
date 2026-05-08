# Synax

Synax is a TypeScript-first local coding agent for developers running local LLMs through Relay or another OpenAI-compatible local gateway.

It is CLI-first, local-first, and intentionally small. Synax focuses on bounded file inspection, compact tool results, controlled edits, provider diagnostics, and explicit context budgets instead of cloud-only agent assumptions.

## Fast Path

```sh
git clone git@github.com:achuthanmukundan00/synax.git
cd synax
npm install
npm run build
cp .synax.toml.example .synax.toml
npm run synax -- doctor --full
npm run synax -- chat
```

The default local provider endpoint is:

```txt
http://127.0.0.1:1234/v1
```

That matches Relay's OpenAI-compatible local inference path.

## What Synax Does

- Runs from the terminal with `synax chat`, `synax ask`, `synax run`, `synax inspect`, `synax config`, and `synax doctor`.
- Talks to Relay through OpenAI-compatible `/v1/chat/completions`.
- Sends a small model-facing tool surface: read, write, edit, and bash.
- Uses bash for terminal workflows, including git and verification commands.
- Supports local session settings for endpoint, model, headers, context budget, model-step limit, and tool-call limit.
- Records inspect context and keeps model-visible data bounded.

## What Synax Is Not

Synax is not a SaaS platform, IDE, web dashboard, hosted agent service, database-backed memory system, or parallel-agent framework.

It is a sharp local CLI tool for constrained local models.
