# Synax Requirements Draft v1.2

## 1. Product Definition

Synax is a local-first coding agent for developers running LLMs on consumer hardware.

It is designed for constrained local models served through tools such as llama.cpp, LM Studio, Ollama, and OpenAI-compatible local inference servers. Synax uses Relay as its preferred compatibility layer for local OpenAI-compatible requests, but it should not be permanently coupled to Relay.

Synax is not a general AI assistant, SaaS coding platform, IDE replacement, autonomous software engineer, or cloud-first coding agent.

Synax is a disciplined CLI-first coding agent built around one core idea:

> Every model-visible instruction, file range, command output, patch decision, and verification step should be explicit, bounded, and inspectable.

The goal is not to pretend local models are Claude. The goal is to build deterministic scaffolding around weaker, less reliable, locally hosted models so they can produce useful coding work safely.

---

## 2. Agent Architecture Assumption

Synax does not require a novel agent architecture.

The v0.1 architecture is intentionally simple:

```text
user task → model call → tool call → tool execution → tool result → model call → response
```

Synax’s differentiation is not the existence of this loop. The loop is standard.

Synax’s differentiation is the policy and instrumentation around the loop:

- bounded tool execution;
- inspect-before-edit enforcement;
- visible context ledger;
- conservative context budgets;
- patch validation;
- human confirmation;
- one-step verification;
- safe failure behavior.

Synax v0.1 should not try to be architecturally clever. It should be operationally strict.

---

## 3. Core Problem

Most modern coding agents assume:

- access to frontier cloud models;
- large practical context windows;
- strong tool-call reliability;
- high instruction-following ability;
- tolerance for large system prompts and aggressive context stuffing.

Synax assumes the opposite.

Local coding models often have weaker reasoning, fragile tool use, inconsistent formatting, and degraded attention long before their advertised context limit. Blindly feeding them large file dumps, bloated instruction stacks, and noisy command output makes them worse, not better.

Synax exists to help local models succeed by enforcing:

- small task loops;
- deliberate file inspection;
- explicit context budgets;
- minimal diffs;
- bounded verification;
- visible failure behavior;
- human-controlled agency.

---

## 4. Design Thesis

Synax should feel less like a vibe-coding wrapper and more like precise developer tooling.

Its central thesis:

> Local coding agents need stricter context discipline, narrower loops, and more visible execution than cloud-model agents.

Synax should optimize for reliability under constraint, not maximum autonomy.

The user should always be able to answer:

- What files did Synax inspect?
- What exact context did the model see?
- What did the model omit or truncate?
- What files changed?
- Why did Synax choose this patch?
- What command verified the result?
- Where did the model fail, if it failed?

---

## 5. Target Users

### Primary User

Developers running coding models locally on consumer hardware, typically with 12–24 GB VRAM, who want practical coding assistance without depending on proprietary cloud models.

This includes developers using:

- llama.cpp;
- LM Studio;
- Ollama;
- local OpenAI-compatible servers;
- Relay;
- quantized models;
- local inference machines exposed over a private network.

The primary user understands that local models are useful but limited. They care about control, context discipline, reproducibility, privacy, cost, and hardware experimentation.

### Secondary User

Developers who normally use cloud coding agents but want a local fallback for privacy, cost control, offline work, experimentation, or sensitive repositories.

---

## 6. Product Principles

### 6.1 Inspect Before Edit

Synax must not patch files it has not inspected.

If a proposed patch touches unread files, Synax should reject the patch or require explicit user confirmation.

### 6.2 Minimal Diffs By Default

Synax should prefer the smallest correct change.

No broad refactors, formatting sweeps, dependency changes, or unrelated cleanup unless explicitly requested.

### 6.3 One Task, One Bounded Loop

Synax should execute one bounded task at a time.

It should avoid uncontrolled autonomous wandering, recursive planning, or indefinite debug loops.

### 6.4 Context Is A Budget, Not A Landfill

Synax should treat context as a scarce execution resource.

It should include only relevant instructions, file ranges, command outputs, and summaries. It should expose what was included, omitted, summarized, or truncated.

Synax should not assume that a model with a 128k context window can effectively use 128k tokens.

### 6.5 Deterministic Scaffolding Around Nondeterministic Output

The model may be nondeterministic. Synax’s harness should not be.

File discovery, context construction, patch validation, command execution, permission gates, and verification behavior should be deterministic where possible.

### 6.6 Human Agency First

Synax acts on behalf of the developer, not instead of the developer.

Every destructive, risky, broad, or ambiguous action should require user approval.

### 6.7 Fail Honestly

If Synax cannot establish something from files, command output, or model response, it should say so.

No fake certainty. No pretending a patch was verified when it was not.

---

## 7. Core Primitive: Context Ledger

The context ledger is Synax’s main differentiator.

For every model call, Synax should maintain a visible ledger of what was included in context.

The ledger should include:

- system/developer instruction sources;
- project instruction files;
- user task;
- file paths and line ranges;
- command outputs;
- summaries;
- omitted or truncated materials;
- approximate token usage;
- remaining context budget.

The context ledger should be compact by default and expandable on demand.

Example compact display:

```text
Context Ledger

Instructions:
  - Synax core policy: 1.2k tokens
  - AGENTS.md summary: 430 tokens

Files:
  - src/openai/chat.ts: lines 40-118
  - src/internal/canonical.ts: lines 1-96

Commands:
  - git status --short
  - npm test -- --runInBand auth.test.ts

Budget:
  - approximate input: 8.7k / 32k preferred tokens
  - truncated: none
```

The ledger should be available for inspection before and after model calls.

---

## 8. v0.1 Product Goal

Synax v0.1 should be a small, disciplined implementation of the standard coding-agent loop, optimized for local models and consumer-GPU constraints.

v0.1 should demonstrate:

- clean OpenAI-compatible provider integration;
- clean Relay integration as the recommended local path;
- disciplined repository inspection;
- visible context selection;
- safe minimal patching;
- one-step verification;
- clear failure behavior.

v0.1 does not need to be impressive because it is autonomous. It needs to be impressive because it is controlled.

The product should prove:

```text
A local model can be useful for real repository work when the agent harness strictly controls context, tools, edits, and verification.
```

---

## 9. v0.1 Core User Journey

The primary v0.1 loop:

```text
1. User starts Synax inside a repository.
2. Synax detects project basics.
3. User gives one task.
4. Synax inspects relevant files and commands.
5. Synax builds a visible context ledger.
6. Synax asks the model for an explanation, diagnosis, or patch.
7. If editing, Synax validates that the patch only touches inspected files.
8. Synax shows the proposed diff.
9. User approves or rejects the patch.
10. Synax applies the patch.
11. Synax runs one bounded verification command.
12. Synax reports result, context used, files changed, and failure state if any.
```

This loop is the product.

Everything else is secondary.

---

## 10. v0.1 Functional Requirements

### 10.1 Project Session Initialization

Synax must start inside a repository and build a lightweight project profile.

It should detect:

- git root;
- current branch;
- dirty working tree status;
- package manager;
- likely language ecosystem;
- likely test/typecheck/lint commands;
- project instruction files, if present.

Possible instruction files:

- `AGENTS.md`
- `CLAUDE.md`
- `.cursorrules`
- `.clinerules`
- `README.md`
- `.synax.md`

Synax should not blindly dump these files into context. Large instruction files should be summarized or selectively included with visible ledger entries.

### 10.2 Interactive Task Loop

Synax must support an interactive CLI loop.

The user should be able to ask for:

- codebase explanation;
- path tracing;
- bug diagnosis;
- small code edits;
- test/debug assistance.

v0.1 should optimize for one task at a time, not long autonomous sessions.

### 10.3 Tool Registry

Synax must implement a small tool registry.

Each tool should define:

- name;
- description;
- input schema;
- safety policy;
- execution function;
- result shape;
- ledger behavior.

Tools should be designed for weaker local models. Tool descriptions should be explicit and constraint-heavy.

Example:

```text
read_file_range

Purpose:
Read a bounded line range from a repo-relative text file.

Rules:
Use this before proposing edits. Do not read generated, binary, vendor, secret, or env files unless explicitly allowed.

Input:
path: repo-relative path
start_line: first line to read
end_line: last line to read
```

### 10.4 File Inspection Tools

Synax must provide deterministic file inspection tools.

Minimum tools:

```text
list_files
read_file_range
search_text
show_git_status
show_git_diff
```

Preferred but optional for v0.1:

```text
search_symbols
show_file_tree
detect_package_scripts
```

The model should request file inspection through structured tool calls or an equivalent controlled mechanism.

### 10.5 Patch Application

Synax must support applying patches under strict constraints.

For v0.1, the preferred edit primitive should be simple and easy to validate.

Recommended v0.1 edit tool:

```text
replace_in_file(path, old_str, new_str)
```

Rules:

- the target file must have been inspected first;
- old_str must match exactly once unless explicitly allowed;
- no patching unread files;
- no broad refactors unless explicitly requested;
- no generated/vendor files unless explicitly requested;
- no secrets or env files unless explicitly requested;
- preserve formatting unless the task requires otherwise;
- show diff before application;
- require user confirmation by default.

A patch should be rejected if:

- it touches unrelated files;
- it modifies files not included in the inspection set;
- it cannot be parsed;
- old_str does not match;
- old_str matches multiple locations without disambiguation;
- it conflicts with the current working tree;
- it exceeds the configured change budget.

Unified diff support can be added later, but v0.1 should prefer the simplest edit path that local models can reliably produce.

### 10.6 Verification Command

After applying a patch, Synax must run at most one bounded verification command by default.

Examples:

```text
npm test
npm run typecheck
npm run lint
pytest path/to/test.py
cargo test module_name
```

The verification command may come from:

- detected project scripts;
- config file;
- user-provided command;
- model recommendation approved by user.

Synax must show:

- command run;
- exit code;
- truncated output if needed;
- whether verification passed, failed, or was skipped.

Synax should not enter an uncontrolled fix-test loop in v0.1.

### 10.7 Provider Support

Synax v0.1 should support OpenAI-compatible Chat Completions first.

Minimum provider configuration:

```toml
[provider]
kind = "openai-compatible"
base_url = "http://localhost:1234/v1"
model = "qwen3.6-35b-a3b"
api_key = ""

[provider.headers]
# optional custom headers
```

Relay should be the recommended local provider path.

Synax should not require Relay if another OpenAI-compatible local endpoint works.

Anthropic Messages support through Relay can be added later.

### 10.8 Doctor Command

Synax must include a doctor command.

Example:

```bash
synax doctor
```

Doctor checks:

- running inside a git repo;
- provider base URL reachable;
- model responds to a minimal request;
- package manager detected;
- configured verification commands exist;
- context budget config is valid;
- Relay-specific health check, if Relay is detected.

Doctor should produce actionable errors.

### 10.9 Configuration

Synax should support a local project config file.

Recommended default:

```text
.synax.toml
```

Minimum fields:

```toml
[provider]
kind = "openai-compatible"
base_url = "http://localhost:1234/v1"
model = "qwen3.6-35b-a3b"
api_key = ""

[context]
max_input_tokens = 64000
preferred_working_tokens = 32000
max_file_tokens = 8000
max_command_output_tokens = 6000
max_instruction_tokens = 4000

[commands]
test = "npm test"
typecheck = "npm run typecheck"
lint = "npm run lint"

[policy]
confirm_patches = true
allow_network_commands = false
allow_install_commands = false
allow_env_file_edits = false
```

Synax should also support global config later, but project config is enough for v0.1.

---

## 11. Candidate CLI Shape

Minimum v0.1 commands:

```bash
synax
synax chat
synax ask "explain this repo"
synax run "fix the failing test"
synax inspect
synax config init
synax doctor
```

### 11.1 synax

Starts interactive mode.

### 11.2 synax chat

Alias for interactive task loop.

### 11.3 synax ask

Runs a read-only task.

Should not edit files.

Example:

```bash
synax ask "trace how streaming responses work"
```

### 11.4 synax run

Runs an edit-capable task.

Example:

```bash
synax run "fix the failing auth test"
```

Should require confirmation before applying patches.

### 11.5 synax inspect

Shows project profile, detected commands, git status, and config summary.

### 11.6 synax config init

Creates a starter `.synax.toml`.

### 11.7 synax doctor

Checks repo, provider, model, commands, and context configuration.

---

## 12. Command Safety Model

Synax should classify shell commands into safety tiers.

### 12.1 Always Allowed

Read-only inspection commands:

```text
pwd
git status
git diff
git branch --show-current
git rev-parse --show-toplevel
ls-style repo inspection
find-style repo inspection within repo
```

### 12.2 Confirmation Required

Potentially safe but meaningful commands:

```text
npm test
npm run typecheck
npm run lint
pytest
cargo test
go test
pnpm test
bun test
```

### 12.3 Blocked By Default

Risky or destructive commands:

```text
rm
rm -rf
mv over existing files
chmod
chown
curl
wget
ssh
scp
npm install
pnpm install
yarn add
pip install
cargo install
docker compose down -v
database migrations
commands touching .env or secret files
```

Blocked commands may only run if explicitly approved by the user and enabled by policy.

---

## 13. Safety And Boundary Requirements

Synax must ask before:

- destructive file operations;
- deleting files;
- editing env/secrets files;
- editing generated/vendor files;
- running install commands;
- running network commands;
- running migration commands;
- touching many files;
- applying broad refactors;
- changing package dependencies.

Synax must avoid by default:

- uncontrolled command loops;
- multi-hour autonomous execution;
- hidden file edits;
- hidden command execution;
- silent truncation;
- silent context stuffing;
- patching files the model has not inspected.

Synax must always show:

- files changed;
- diff;
- verification command;
- verification result;
- whether the task is complete, partial, failed, or unverified.

---

## 14. Failure Behavior

Synax v0.1 must define predictable failure states.

### 14.1 Malformed Model Output

If the model emits malformed tool calls, malformed JSON, or an invalid patch:

```text
1. Synax attempts one repair prompt.
2. If repair fails, Synax stops.
3. Synax shows the failure reason.
```

### 14.2 Patch Touches Unread Files

If a model proposes edits to files it has not inspected:

```text
1. Reject the patch by default.
2. Explain which files were unread.
3. Offer to inspect those files and retry.
```

### 14.3 replace_in_file Match Failure

If `replace_in_file` cannot safely apply:

```text
1. If old_str has no match, reject.
2. If old_str has multiple matches, reject.
3. Ask the model to inspect more context or produce a more specific replacement.
4. Do not guess.
```

### 14.4 Verification Fails

If the verification command fails:

```text
1. Show command output.
2. Mark task as failed or partially complete.
3. Allow one optional diagnosis pass.
4. Do not enter an automatic loop.
```

### 14.5 Context Budget Exceeded

If relevant files or outputs exceed context budget:

```text
1. Truncate or summarize with visible markers.
2. Add truncation to context ledger.
3. Tell the model what was omitted.
```

### 14.6 Ambiguous Task

If the task is too broad:

```text
1. Ask the user to narrow the task, or
2. Convert it into a read-only inspection task.
```

Example:

```text
"Improve this repo" should become:
"I can inspect the repo and identify the top 3 concrete improvement targets."
```

### 14.7 Dirty Working Tree

If the repo has existing uncommitted changes:

```text
1. Show git status.
2. Warn the user.
3. Continue only after confirmation for edit-capable tasks.
```

---

## 15. Context Policy

The default context policy should be conservative.

Recommended defaults:

```toml
[context]
max_input_tokens = 64000
preferred_working_tokens = 32000
max_file_tokens = 8000
max_command_output_tokens = 6000
max_instruction_tokens = 4000
```

Synax should prefer:

- selected file ranges over full files;
- search results over repo dumps;
- summaries for large instruction files;
- targeted command output over full logs;
- explicit omission markers over hidden truncation.

The preferred working budget should matter more than the theoretical maximum.

---

## 16. v0.1 Acceptance Criteria

Synax v0.1 is acceptable when it can complete the following in a real repository.

### 16.1 Setup And Doctor

Synax must:

- start inside a git repo;
- detect project basics;
- load `.synax.toml`;
- connect to a Relay/OpenAI-compatible endpoint;
- send a successful test prompt to the configured model;
- report actionable errors if provider setup fails.

### 16.2 Read-Only Codebase Task

Given a prompt like:

```text
Trace how this route reaches the response formatter.
```

Synax must:

- search relevant files;
- inspect selected file ranges;
- answer with cited file paths and line ranges;
- show the context ledger;
- make no edits.

### 16.3 Small Patch Task

Given a prompt like:

```text
Fix this failing test.
```

Synax must:

- inspect relevant files before editing;
- propose a minimal patch;
- reject patches to unread files;
- show the diff;
- require confirmation by default;
- apply the patch;
- run one verification command;
- report pass/fail/unverified status.

### 16.4 Context Ledger

For every model call, Synax must be able to show:

- instruction sources included;
- files and line ranges included;
- command outputs included;
- approximate token usage;
- truncations or omissions.

### 16.5 Failure Handling

Synax must fail safely when:

- the model emits malformed output;
- the patch cannot be applied;
- the patch touches unread files;
- verification fails;
- provider connection fails;
- context budget is exceeded.

---

## 17. Explicit Non-Goals For v0.1

Synax v0.1 will not attempt:

- outperforming Claude Code on frontier-model workloads;
- inventing a novel agent architecture;
- full autonomous multi-hour coding tasks;
- multi-agent orchestration;
- browser automation;
- IDE extension integration;
- plugin marketplace;
- complex memory systems;
- automatic large-scale refactors;
- automatic PR generation;
- custom model fine-tuning;
- replacing Relay;
- supporting every provider protocol;
- advanced ACP/MCP integration;
- cloud-first workflows;
- self-modifying setup agents.

Synax v0.1 should do one bounded repository task well before expanding.

---

## 18. Recommended v0.1 Decisions

These should be treated as default decisions unless contradicted by implementation reality.

### 18.1 Language

Use TypeScript for v0.1.

Reason: faster iteration, strong Node CLI ecosystem, easier integration with existing OpenAI-compatible SDK patterns, and faster dogfooding against Relay.

Rust can be reconsidered later for distribution, performance, or single-binary ergonomics.

### 18.2 Provider API

Support OpenAI-compatible Chat Completions first.

Anthropic Messages through Relay can come later.

### 18.3 UI

Build CLI first.

A TUI can come after the core loop is stable.

### 18.4 Patch Confirmation

Require explicit confirmation before applying patches by default.

Allow auto-apply later through config.

### 18.5 ACP/MCP

Defer ACP/MCP until the core loop is reliable.

Do not make protocol support a v0.1 dependency.

### 18.6 Context Ledger Visibility

Always show compact context ledger information.

Allow expanded ledger view on demand.

### 18.7 Demo Repo

Use either:

- Relay itself; or
- a small TypeScript repo with one known failing test.

The demo should show:

```text
inspect → ledger → patch → diff → verify → report
```

### 18.8 Differentiator From Cline TUI

Synax is not differentiated merely by being local-first.

Synax is differentiated by:

- explicit context ledger;
- conservative local-model loop;
- patch constraints;
- visible context budgets;
- deterministic tool scaffolding;
- no assumption that more context equals better output.

---

## 19. Product Positioning

### 19.1 One-Sentence Positioning

Synax is a local-first coding agent for consumer-GPU developers that makes every model-visible instruction, file range, command output, and patch decision explicit, bounded, and inspectable.

### 19.2 Short Positioning

Most coding agents are designed around frontier cloud models and oversized context windows. Synax is designed for local models that need stricter scaffolding: smaller loops, visible context, minimal diffs, and bounded verification.

### 19.3 Blunt Positioning

Synax does not pretend your local model is Claude. It gives the model a fighting chance by controlling what it sees, what it can touch, and how its work is verified.

---

## 20. v0.1 Success Definition

Synax v0.1 succeeds if it becomes the tool a local-LLM developer trusts for small, real repo tasks.

It does not need to solve entire issues autonomously.

It needs to reliably handle:

```text
"Explain this code path."
"Find where this behavior is implemented."
"Fix this small failing test."
"Make this minimal change."
"Show me exactly what context you used."
```

The product is successful when the user feels:

```text
I know what the agent saw.
I know what it changed.
I know what it verified.
I know where it failed.
I stayed in control.
```

That is the wedge.
