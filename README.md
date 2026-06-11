# Synax

An agentic kernel and CLI/TUI software orchestration engine optimized for high-velocity local deployment. Built in 6 weeks from first commit to self-maintaining production system.

## 🔄 The Self-Bootstrapping Kernel

Synax was forged via asymmetric resource allocation — routing low-complexity structural logic across cheap open-weight endpoints, followed by a concentrated architectural pass using Claude Fable 5.

As of June 2026, the system has achieved structural closure. The construction phase is complete, and Synax has transitioned into an autonomous self-maintenance cycle:

- **Production Dogfooding:** Synax is actively deployed to track its own issues, refactor its orchestration loops, and maintain its own repository.
- **Sovereign Execution:** Operational steady-state maintenance runs entirely on local iron using quantized weights (**QAT Gemma 4**).

## 📊 Core Performance & Unit Economics

| Dimension | Metric | Engineering Value |
| :--- | :--- | :--- |
| **Scale** | Net Lines of Code / Source Files | **+84,370 LOC** / 343 Files (70 test files) |
| **Velocity** | Total Commits / Median PR Merge Time | **421 Commits** / 50 Minutes |
| **Throughput** | Issues Closed / Close Rate | **71 of 80 Closed** / 89% |
| **Arbitrage** | Cost Per Million Tokens | **$0.137 / M Tokens** (14× market efficiency vs. cloud-first agents) |

## 🏗 Architecture

Synax is a TypeScript-first, CLI-first, local-first coding agent. It operates as a compatibility-and-control layer between messy local inference and real software work.

- **8 parser pipeline** for tool-call survival across Qwen, Llama, Mistral, DeepSeek, Hermes, GLM, and XLAM models
- **Multi-provider backend** supporting Relay, llama.cpp, Ollama, OpenAI, Anthropic, and any OpenAI-compatible endpoint
- **Full TUI** with real-time streaming, collapsible panels, model-aware context visualization, and steering controls
- **Session system** with SQLite FTS5 holographic memory, deterministic compaction, and fork() sub-agent spawning
- **Orchestration manager** for sequential and parallel sub-agent execution with budget-aware planning
- **Observability stack** — structured logging, span tracing, token cost tracking, and `inspect --metrics` dashboard
- **SDK surface** for embedding Synax as a library with custom tool registration
- **Recovery pipeline** — JSON/XML auto-repair for malformed local-model tool calls (7 failure recipes)

## 🚀 Quick Start

```bash
npm install -g synax
synax chat
```

Configure your endpoint:

```bash
synax config set provider.openai.baseUrl http://localhost:8080/v1
synax config set model qwen3-coder
```

## 📖 Documentation

Full docs at [achu.dev/work/synax](https://achu.dev/work/synax) — architecture, provider setup, tool-call parsing, session management, SDK API, and TUI guide.

## 🔧 Commands

| Command | Purpose |
| :--- | :--- |
| `synax chat` | Interactive TUI coding session |
| `synax run --task "..."` | Single-turn agent execution |
| `synax ask "..."` | Read-only codebase query |
| `synax inspect` | Session browser and replay |
| `synax inspect --metrics` | Token usage and cost dashboard |
| `synax doctor` | Provider/model compatibility diagnostics |
| `synax config` | Manage configuration |

## ⚙ Self-Maintenance Loop

Synax maintains itself. Issues are filed by the agent, PRs are authored through its own orchestration pipeline, and verification runs through its own CLI. The ouroboros is operational.

---

**Status:** Self-maintaining. **Stack:** TypeScript, Node.js, SQLite FTS5. **Runtime:** QAT Gemma 4 (local), relay gateway.
