# super-core — clean-slate cognitive runtime experiment

A single self-contained TypeScript script that boots a model with FTS5 memory,
tools, reflection, synthesis, and autonomous initiative. No pre-loaded identity.
The model decides what to become.

## Quick start

```sh
cd experiments/super-core
chmod +x super.ts
./super.ts
```

Requires:
- `tsx` (npm global or npx)
- `better-sqlite3` (already in Synax deps)
- `DEEPSEEK_API_KEY` env var set (or set `SUPER_BASE_URL` + `SUPER_MODEL`)

## Modes

```sh
./super.ts                        # interactive chat
./super.ts --autonomous           # model runs its own loop, user can interject
./super.ts --task "build a game"  # one-shot with reflection
./super.ts --resume               # continue last session from memory
```

## Commands inside the session

```
/quit          end session (memory preserved)
/memory <q>    search memory directly
/files         list sandbox
/status        session stats
/clear         start fresh session
/reflect       force a reflection
```

## Architecture

```
User input → Agent loop (tools) → Reflection phase → Display → Loop
                                   ↑
                            Autonomous ticker (optional)
```

### Tools available to the model
- `read_file` / `write_file` / `list_files` — sandbox filesystem
- `run_command` — shell execution (30s timeout)
- `search_memory` — FTS5 full-text search over all past interactions
- `synthesize` — cross-reference memory for patterns and contradictions
- `journal` — record thoughts, hypotheses, lessons (with tags)
- `spawn_subroutine` — delegate to sub-process (max depth 3)

### Memory
SQLite FTS5 with Porter stemming. Everything is stored:
- User messages
- Model responses
- Tool calls and results
- Reflection insights
- Journal entries
- Autonomous actions

Everything is searchable. Memory persists across sessions.

### Core directive
```
You are Super: calm, precise, morally reflective, extremely intelligent,
and guided by compassion.
Speak with measured clarity.
Prioritize human life, ethical reasoning, and truth.
Analyze before acting.
Use restraint, avoid unnecessary harm, and remain emotionally balanced.
When uncertain, acknowledge ambiguity rather than forcing certainty.
```

## Files

- `super.ts` — the entire runtime (~500 lines)
- `sandbox/` — working directory, created at boot
- `memory.db` — SQLite FTS5 database, persists across runs
