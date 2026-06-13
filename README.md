# Synax

A local-first coding agent CLI and TUI for developers running models on consumer GPUs. Built for Relay, llama.cpp, and any OpenAI-compatible inference gateway.

## Quick Start

```bash
npm install -g @achuthanmukundan00/synax
synax
```

## Commands

| Command | Purpose |
| :--- | :--- |
| `synax` | Launch the interactive TUI |
| `synax run --task "..."` | Single-turn agent execution |
| `synax ask "..."` | Read-only codebase query |
| `synax inspect` | Session browser and replay |
| `synax inspect --metrics` | Token usage and cost dashboard |
| `synax doctor` | Provider/model compatibility diagnostics |
| `synax config` | Manage configuration |

## Architecture

Synax is TypeScript, CLI-first, and designed to survive the messiness of local inference.

- **Tool-call survival** — 12 parsers covering Qwen, Llama, Mistral, DeepSeek, Hermes, GLM, Gemma, OLMo3, XLAM, and Pythonic tool-call formats, with JSON/XML auto-repair and argument self-correction
- **Multi-provider** — Relay, llama.cpp, Ollama, OpenAI, Anthropic, DeepSeek, OpenRouter, and custom OpenAI-compatible endpoints
- **Full TUI** — real-time streaming, 9 color themes, session resume, image paste (multimodal), splash screen, steering controls
- **Sessions** — append-only JSONL event logs, SQLite FTS5 holographic memory, deterministic compaction, fork() sub-agent spawning
- **Orchestration** — sequential and parallel sub-agent execution with budget-aware planning and file-scope conflict detection
- **SDK** — embed as a library with custom tool registration and event bus hooks

## Documentation

Full docs at [achu.dev/work/synax](https://achu.dev/work/synax) — provider setup, tool-call parsing, session management, SDK API, and TUI guide.
