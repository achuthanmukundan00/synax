# Synax

A local-first coding agent for consumer-GPU developers.

Synax makes every model-visible instruction, file range, command output, and patch decision **explicit, bounded, and inspectable**. It is designed for developers running local LLMs on constrained hardware who want practical coding assistance without depending on proprietary cloud models.

<!-- omit in toc -->

## Table of Contents

- [Positioning](#positioning)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [v0.2 Local Agent Usage](#v02-local-agent-usage)
- [CLI Commands](#cli-commands)
- [Configuration](#configuration)
- [Context Budgeting](#context-budgeting)
- [Safety Model](#safety-model)
- [Failure Behavior](#failure-behavior)
- [Project Structure](#project-structure)
- [Development](#development)
- [Non-Goals](#non-goals)
- [License](#license)

## Positioning

Most coding agents assume frontier cloud models with large context windows and strong tool-call reliability. Synax assumes the opposite: local models that need stricter scaffolding, smaller loops, visible context, minimal diffs, and bounded verification.

Synax is not a general AI assistant, SaaS coding platform, IDE replacement, or autonomous software engineer. It is a disciplined CLI-first coding agent.

## Features

- **CLI-first design** — clean `commander` subcommand structure with predictable behavior
- **Project inspection** — `synax inspect` detects git info, package manager, detected commands, and config summary
- **Interactive chat** — `synax chat` and `synax ask` provide read-only and edit-capable task loops
- **Doctor command** — `synax doctor` checks project configuration and provider readiness
- **OpenAI-compatible tool calls** — sends standard `tools` requests and accepts Qwen/Unsloth text fallback tool-call blocks
- **Configuration** — `.synax.toml` project config with provider, context, commands, and policy sections
- **Context budgeting** — conservative token limits for files, commands, instructions, and overall input
- **Safety policies** — command safety tiers, patch confirmation, and file edit restrictions
- **Structured logging** — deterministic execution traces with visible context ledgers
- **TypeScript-first** — strict TypeScript with ESLint and Prettier

## Requirements

- **Node.js** ≥ 18.0.0
- **npm** (or your preferred package manager)

## Installation

```sh
# Clone the repository
git clone git@github.com:achuthanmukundan00/synax.git
cd synax

# Install dependencies
npm install

# Build the CLI
npm run build
```

## Quick Start

```sh
# Check project and provider health
npx synax doctor --full

# Inspect the current project
npx synax inspect

# Start interactive chat
npx synax

# Ask a read-only question
npx synax ask --question "Trace how streaming responses work"

# Run an edit-capable task
npx synax run --task "Fix the failing auth test"
```

## v0.2 Local Agent Usage

Synax v0.2 is a lean local code-editing agent for OpenAI-compatible local providers such as Relay, llama.cpp-compatible servers, or LM Studio-style endpoints.

Prerequisites:

- Node.js 18 or newer
- A local OpenAI-compatible `/v1/chat/completions` server
- A configured model name in `.synax.toml`

Example `.synax.toml`:

```toml
contextBudgetTokens = 16000

[provider]
kind = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
model = "qwen3.6-local"
api_key = "local"
timeout_seconds = 120

[verification]
defaultCommand = "npm test"
```

Typical local flow:

```sh
npm run build
npm run synax -- doctor --full
npm run synax -- inspect
npm run synax -- ask --question "Summarize this project in 5 bullets."
npm run synax -- run --task "Create docs/agent-demo.md explaining Synax in 5 bullets."
npm run synax -- chat
```

`synax run --task "<task>"` starts a fresh conversation, sends tool schemas to the model, executes safe repo-local tool calls, appends tool results back into the conversation, stops when the model returns a normal assistant answer, then runs `[verification].defaultCommand` when configured.

`synax chat` starts a persistent interactive shell:

```txt
Synax v0.2 local agent
Repo: /path/to/repo
Model: qwen3.6-local
Commands: /help /inspect /verify /clear /status /exit

synax> summarize the project
synax> create docs/agent-demo.md with 5 bullets
synax> /verify
synax> /exit
```

Slash commands:

| Command | Behavior |
| --- | --- |
| `/help` | Show chat commands |
| `/inspect` | Print the current inspect profile |
| `/verify` | Run the configured verification command |
| `/clear` | Reset the chat conversation |
| `/status` | Show a compact git status summary |
| `/exit`, `/quit` | Exit cleanly |

Safety notes:

- File tools reject unsafe paths, generated directories, env files, and path traversal.
- `replace_in_file` requires the file to have been read first and `oldStr` to match exactly once.
- `create_file` only creates new repo-local text files and fails when the file already exists.
- Synax does not expose unrestricted shell execution. Verification runs only from configured verification.

Current limitations:

- Tool-call reliability depends on the local model/server.
- Streaming is not polished in v0.2; non-streaming correctness is the priority.
- `synax run --plan` remains a placeholder.
- Native Anthropic support, browser UI, IDE integration, and parallel agents are out of scope.

## CLI Commands

| Command | Description |
| --- | --- |
| `synax` | Start interactive mode and show help |
| `synax chat` | Interactive coding agent session |
| `synax ask` | Ask a read-only question (no file edits) |
| `synax run` | Execute a task with edit capabilities |
| `synax inspect` | Inspect project metadata and configuration |
| `synax config` | Manage `.synax.toml` configuration |
| `synax doctor` | Check system health and configuration |

### Chat command

```sh
# Interactive mode
synax chat

# Single-shot message mode
synax chat --message "Explain the route handling in this codebase"
```

### Ask command

```sh
# Read-only inspection
synax ask --question "Find where this behavior is implemented"
```

### Run command

```sh
# Execute a one-shot task
synax run --task "Fix the failing test"

# Execute from a plan file
synax run --plan plan.md
```

`synax run` uses the same bounded tool loop as `synax chat`. It inspects files with read-only tools, allows exact `replace_in_file` edits to inspected files, supports safe new-file creation, then runs one configured verification command.

### Inspect command

```sh
# Default output
synax inspect

# JSON output
synax inspect --json

# Specific sections
synax inspect --section git --section packageManager

# Show full project profile
synax inspect --profile

# Brief summary
synax inspect --brief
```

### Config command

```sh
# Initialize configuration
synax config init
```

### Doctor command

```sh
# Run fast local checks
synax doctor

# Include provider endpoint and model request checks
synax doctor --full
```

## Configuration

Synax uses `.synax.toml` for project-level configuration. The config file is optional — the CLI works with sensible defaults.

```toml
[provider]
kind = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
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

## Context Budgeting

Synax treats context as a budget, not a landfill. The default conservative limits are:

| Budget | Default | Purpose |
| --- | --- | --- |
| `max_input_tokens` | 64,000 | Total input to the model |
| `preferred_working_tokens` | 32,000 | Target working budget |
| `max_file_tokens` | 8,000 | Per-file token limit |
| `max_command_output_tokens` | 6,000 | Per-command output limit |
| `max_instruction_tokens` | 4,000 | Instruction file limit |

Synax prefers selected file ranges over full files, search results over repo dumps, and summaries for large instruction files.

## Safety Model

Synax classifies shell commands into safety tiers:

| Tier | Commands | Approval |
| --- | --- | --- |
| **Always Allowed** | `git status`, `git diff`, `ls`, `find` | None |
| **Confirmation Required** | `npm test`, `npm run typecheck`, `pytest` | User |
| **Blocked By Default** | `rm`, `npm install`, `curl`, `ssh` | Policy + User |

Patches are also subject to safety rules:

- Target files must have been inspected before editing
- Patches must only touch inspected files
- User confirmation is required by default
- Formatting churn and unrelated cleanup are prohibited

## Local Qwen / Unsloth Tool Calling

Synax targets OpenAI-compatible Chat Completions first. For local Unsloth Qwen3.6 GGUFs, run a compatible local server and configure:

```toml
[provider]
kind = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
model = "qwen3.6-local"
api_key = "sk-no-key-required"
```

Synax sends `tools` with `tool_choice = "auto"`. It accepts standard `message.tool_calls` and Qwen-style fallback blocks such as:

```txt
<tool_call>{"name":"read_file_range","arguments":{"path":"src/math.ts"}}</tool_call>
```

See `docs/acceptance-demo.md` for the fixture and demo flow.

## Failure Behavior

Synax fails safely and predictably:

| Scenario | Behavior |
| --- | --- |
| **Malformed model output** | One repair prompt, then stop with explanation |
| **Patch touches unread files** | Reject with list of unread files |
| **replace\_in\_file match failure** | Reject, ask for more specific replacement |
| **Verification fails** | Show output, mark partial/fail, one diagnosis pass |
| **Context budget exceeded** | Truncate with visible markers, report omissions |
| **Ambiguous task** | Narrow to read-only inspection or ask for clarification |
| **Dirty working tree** | Warn, continue only after confirmation |

## Project Structure

```
synax/
├── src/
│   ├── cli.ts            # CLI entrypoint and command registration
│   ├── commands/         # Command implementations
│   │   ├── ask.ts        # Read-only question command
│   │   ├── chat.ts       # Interactive chat command
│   │   ├── config.ts     # Configuration management
│   │   ├── doctor.ts     # System health check
│   │   ├── inspect.ts    # Project metadata inspection
│   │   └── run.ts        # Task execution command
│   ├── config/           # Configuration loading and parsing
│   │   ├── profile.ts    # Project profile builder
│   │   └── project.ts    # Project config loader
│   ├── __tests__/        # Test files
│   └── llm/              # LLM provider integration (planned)
├── docs/
│   ├── specs/            # Specification documents
│   └── synax-requirements-v1.2.md
├── package.json
├── tsconfig.json
├── .synax.toml           # Project configuration
└── .eslintrc.cjs         # ESLint configuration
```

## Development

```sh
# Type check
npm run typecheck

# Lint
npm run lint

# Lint with auto-fix
npm run lint:fix

# Format
npm run format

# Run tests
npm test
```

## Non-Goals

Synax v0.1 explicitly does **not**:

- Replace your IDE or editor
- Connect to proprietary cloud-only models
- Run as a daemon or background service
- Persist state in a database
- Provide a web UI or dashboard
- Implement parallel agents
- Add Rust, Python, or Docker infrastructure
- Add cloud-hosted APIs

See `AGENTS.md` for the full product constraints and design philosophy.

## License

MIT
