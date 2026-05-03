# Synax

Instructions for AI coding agents working in this repository.

## Project

Synax is a TypeScript-first local coding agent for developers running local LLMs on consumer hardware.

Synax is designed to work cleanly with Relay, an OpenAI/Anthropic-compatible local inference gateway.

Do not treat Synax as a cloud agent platform, SaaS product, IDE, web dashboard, or general automation framework.

## Hard rules

- Use TypeScript for v0.1.
- Do not introduce Rust for v0.1.
- Do not introduce Python services.
- Do not introduce a database.
- Do not introduce Docker infrastructure unless explicitly requested.
- Do not add a web UI unless explicitly requested.
- Do not add cloud-only assumptions.
- Do not require OpenAI-hosted APIs for normal local use.
- Do not add large dependencies without a clear reason.
- Do not make unrelated cleanup changes.
- Do not refactor architecture unless explicitly requested.
- Do not claim verification passed unless you ran it.
- Do not silently skip failed verification.
- Do not blindly load the whole repository into context.

## Product constraints

Synax must remain:

- CLI-first
- local-first
- Relay-compatible
- small enough to understand
- usable with constrained local models
- careful with context usage
- deterministic where practical

Prefer boring, inspectable control flow over clever agent behavior.

## Naming

Use `Synax` for the product name in prose.

Use `synax` for:

- CLI command
- npm package name
- binary name
- config filenames
- code identifiers
- examples

Examples:

```sh
synax run "fix the failing test"
synax plan "add config loading"
````

## Repository shape

Prefer this module layout unless the existing repository already differs:

```txt
src/
  cli/
  agent/
  config/
  llm/
  tools/
  context/
  prompts/
  utils/
```

Responsibilities:

* `cli/`: argument parsing and command dispatch
* `agent/`: planning, execution loop, task lifecycle
* `config/`: config discovery, parsing, defaults, validation
* `llm/`: Relay/OpenAI-compatible client code
* `tools/`: file, search, edit, and shell tools
* `context/`: context budgeting, transcript compaction, file selection
* `prompts/`: system/developer/task prompt templates
* `utils/`: small shared helpers

Prefer private modules and explicit exports.

Avoid large files. If a file grows past roughly 500 LoC, prefer adding a focused module instead of extending it further.

Do not create helper functions used only once unless they clarify a genuinely complex operation.

## v0.1 scope

Implement only the minimal useful CLI coding agent.

In scope:

* CLI entrypoint
* project config loading
* global config loading if simple
* Relay/OpenAI-compatible chat client
* basic agent loop
* plan mode
* targeted file inspection
* controlled file editing
* shell command execution with guardrails
* context budgeting
* compact transcript/state handling
* structured logs
* smoke tests
* README/spec updates

Out of scope unless explicitly requested:

* Rust
* persistent memory database
* vector search
* plugin marketplace
* hosted service
* multi-user server
* background daemon
* browser UI
* IDE extension
* parallel agents
* complex sandboxing
* autonomous long-running workflows

## Relay compatibility

Treat Relay as the preferred inference path.

Support configurable:

* base URL
* model name
* API key
* timeout
* context budget
* streaming flag

Use this as the default local base URL unless the project already defines another default:

```txt
http://127.0.0.1:1234/v1
```

Do not hardcode a specific model.

Do not assume the API key is meaningful for local inference. Allow dummy/local keys.

Prefer OpenAI-compatible chat completions first. Add Anthropic compatibility only when the repository scope calls for it.

Non-streaming correctness comes before streaming polish.

## Config

Prefer a simple project config file:

```txt
synax.config.json
```

Keep config optional. The CLI must work with defaults.

Reasonable v0.1 shape:

```json
{
  "model": "qwen3.6-35b-a3b",
  "baseUrl": "http://127.0.0.1:1234/v1",
  "contextBudgetTokens": 16000,
  "subagents": {
    "enabled": false,
    "mode": "sequential"
  },
  "verification": {
    "defaultCommand": "npm test"
  }
}
```

When changing config shape:

* update docs
* update examples
* update tests
* preserve backwards-compatible defaults where practical

## Context rules

Context is a budget.

Do not load large files without a reason.

Never read these paths unless explicitly relevant:

```txt
node_modules/
.git/
dist/
build/
coverage/
.next/
.cache/
.vite/
*.lock
package-lock.json
pnpm-lock.yaml
yarn.lock
```

Prefer this inspection sequence:

1. inspect `package.json`
2. inspect project tree
3. inspect relevant files only
4. inspect nearby tests
5. inspect docs/specs if behavior changes

For large files, read targeted sections only.

Do not paste full files into prompts when a small excerpt is enough.

## Agent behavior

Follow this loop for most tasks:

```txt
1. Understand the user request.
2. Inspect the project structure.
3. Inspect relevant files.
4. Make a compact plan for non-trivial changes.
5. Edit the smallest necessary surface.
6. Run the narrowest useful verification.
7. Report changed files, verification, and caveats.
```

Do not edit before inspecting.

Do not invent architecture when existing code already provides a pattern.

Do not continue making speculative changes after the requested task is complete.

## Planning

Use plan mode for:

* multi-file changes
* config changes
* agent-loop changes
* tool execution changes
* context management changes
* LLM protocol changes
* CLI behavior changes
* test architecture changes

Plans must be short and executable.

Avoid vague plan items like “improve architecture.”

Prefer:

```txt
1. Inspect existing config loading.
2. Add default baseUrl/model handling.
3. Add tests for missing config and explicit config.
4. Run typecheck and targeted tests.
```

## Sequential subagents

Synax may support sequential subagent-style execution.

Do not implement parallel subagents in v0.1.

Sequential subagents should behave as controlled task phases, not independent autonomous workers.

If implementing subagent support:

* require config or explicit task opt-in
* enter plan mode first
* split work into narrow phases
* estimate context cost before each phase
* preserve only compact summaries between phases
* stop when context budget becomes unsafe
* produce one coherent final patch
* avoid hidden state

Subagents exist to help smaller local models succeed, not to maximize autonomy.

## File reads

Use targeted file reads.

Before editing a file:

* read the file or relevant section
* inspect neighboring conventions
* inspect relevant tests if present

Do not rewrite files from memory.

Do not read generated files unless the task is specifically about generated output.

## File edits

Make minimal diffs.

Preserve:

* existing formatting style
* module boundaries
* naming conventions
* exported API shape unless changing it is required
* comments that document non-obvious behavior

Avoid:

* drive-by refactors
* formatting churn
* dependency swaps
* renames unrelated to the task
* moving files unnecessarily
* creating duplicate implementations

After editing, inspect the diff before finalizing.

## Shell commands

Prefer read-only commands first:

```sh
pwd
ls
find
rg
cat
sed
git status
git diff
npm run
```

Inspect `package.json` before running npm scripts.

Do not run destructive commands unless explicitly requested.

Avoid:

```sh
rm -rf
git reset --hard
git clean -fd
git push --force
sudo
chmod -R
chown -R
npm install -g
```

Do not install global packages.

Do not modify system files.

## Dependency policy

Do not add dependencies casually.

Before adding a dependency:

1. inspect `package.json`
2. check existing dependencies
3. prefer Node.js standard APIs where reasonable
4. justify the dependency in the final report

Avoid heavy frameworks.

Avoid dependencies that imply a larger product direction than v0.1 needs.

## TypeScript conventions

Use strict TypeScript.

Prefer:

* explicit return types on exported functions
* discriminated unions for structured states
* small interfaces near their usage
* narrow error types where useful
* async/await over promise chains
* readable control flow over clever abstractions

Avoid:

* `any`
* broad `unknown` without narrowing
* global mutable state
* hidden singleton clients
* implicit process exits deep inside modules
* mixing CLI rendering with core logic

CLI code may call `process.exit`.

Library/core modules should return structured results or throw typed errors instead.

## LLM client conventions

Keep provider logic isolated under `llm/`.

Do not scatter HTTP calls through the agent loop.

LLM request construction should be inspectable.

Log enough metadata to debug locally:

* base URL
* model
* streaming enabled/disabled
* prompt token estimate if available
* response status
* elapsed time

Do not log API keys.

Do not log full prompts by default unless debug mode explicitly enables it.

## Tool calling conventions

Tools must have explicit input and output shapes.

Tool results should be compact.

For file tools, include:

* path
* operation
* success/failure
* concise content or summary
* error message when failed

For shell tools, include:

* command
* exit code
* stdout excerpt
* stderr excerpt
* elapsed time

Do not dump massive command output into model context.

Truncate or summarize long outputs.

## Error handling

Fail clearly.

Errors should explain:

* what failed
* where it failed
* what command or operation was attempted
* whether the repository was changed
* what the user can do next, if obvious

Do not swallow errors.

Do not convert all errors into generic strings too early.

## Testing

Prefer targeted tests.

Check `package.json` before choosing verification commands.

Good commands may include:

```sh
npm run typecheck
npm run lint
npm test
npm run test
npm run build
npm run smoke
```

Only run scripts that exist unless adding the script is part of the task.

For CLI changes, prefer smoke tests that exercise the actual CLI path.

For config changes, test:

* missing config
* default config
* explicit config
* invalid config

For LLM client changes, test request shaping without requiring a live model server unless the repo already has live smoke tests.

## Verification order

After code changes:

1. run formatter if configured
2. run typecheck if configured
3. run targeted tests
4. run build if relevant
5. run smoke command if relevant

Do not run broad expensive commands when a targeted command is enough.

Do not ask before running normal project-local verification commands.

Ask before running commands that are destructive, unusually expensive, or require network credentials.

## Documentation

Update docs when behavior changes.

Docs should be direct and operational.

Document:

* install
* run
* configure
* Relay setup
* model/base URL options
* known limitations
* verification commands

Avoid hype.

Avoid vague claims like “production-ready” unless the repository actually supports that claim.

## README distinction

Do not turn `AGENTS.md` into `README.md`.

`AGENTS.md` is for agent operating rules.

`README.md` is for human onboarding.

Keep this file imperative.

## GitHub issues

When creating or modifying issues, use concrete deliverables.

Preferred issue format:

```md
## Goal

One clear outcome.

## Scope

- Concrete item
- Concrete item
- Concrete item

## Non-goals

- Explicitly excluded item

## Acceptance criteria

- [ ] Observable result
- [ ] Tests or smoke checks pass
- [ ] Docs updated if behavior changed
```

Do not create vague issues like:

```txt
Improve agent
Make Synax better
Add intelligence
```

## Final response format

When reporting completed work, use:

```md
## Changed

- `path/file`: what changed

## Verified

- `command`: result

## Notes

- caveats, skipped checks, or follow-up issues
```

If no files changed, say so.

If verification failed, include the failure.

If verification was not run, say why.

## Default stance

Prefer small, correct, local, inspectable changes.

Synax should feel like a sharp CLI tool for local model users, not a bloated assistant framework.

```
