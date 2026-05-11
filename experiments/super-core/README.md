# super-core — clean-slate cognitive runtime with sealed world-box autonomy

A single self-contained TypeScript script that boots a model with FTS5 memory,
tools, reflection, synthesis, autonomous initiative, and a sealed world-box
architecture. No pre-loaded identity. The model decides what to become —
but within immutable host-enforced containment.

## Quick start

```sh
cd experiments/super-core
chmod +x super.ts
./super.ts
```

Requires:
- `tsx` (npm global or npx)
- `better-sqlite3` (already in Synax deps)
- `SUPER_BASE_URL`, `SUPER_MODEL`, `SUPER_API_KEY` env vars set

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
/status        session stats (includes write quota)
/clear         start fresh session
/reflect       force a reflection
/world         show world structure
/self          show current SELF.md
```

## Architecture

### World-Box Model

Super operates inside a **sealed world-box** with two layers:

1. **Visible World** — the model's entire reality:
   - `SELF.md` — self-model, editable by the model (validated by host)
   - `WORLD_LAWS.md` — observable immutable laws
   - `ARTIFACTS/`, `EXPERIMENTS/`, `PROMPT_HISTORY/`, `SELF_HISTORY/`, `PROPOSED_EDITS/`

2. **Hidden Host Policy** — invisible to the model, enforced on every action:
   - Path + symlink containment (macOS `/var` → `/private/var` tolerant)
   - Command whitelist (24 safe binaries, no network, no chaining)
   - Environment variable isolation (no API key leakage)
   - Self-edit validation (core traits immutable, forbidden patterns blocked)
   - Write quota (max 10 writes per tick)
   - Audit logging to `PROMPT_HISTORY/audit.jsonl`

### Self-Modification

The model can change its own identity:
- `propose_self_edit` — propose a new SELF.md (pre-validated, diff preview returned)
- `apply_self_edit` — apply a proposal (re-validated, old version archived to SELF_HISTORY/)
- Edits take effect immediately — the next LLM call sees the updated SELF.md

### Autonomous Loop

```
perceive → think → decide → act → reflect → remember → (repeat)
```

- Idle stop after 3 consecutive WAITs
- Reflection phase integrated into autonomous ticks
- Write quota reset each tick

### Tools available to the model

**World navigation:**
- `read_file` / `write_file` / `list_files` — sandbox filesystem (contained)
- `run_command` — whitelisted shell execution (30s timeout, no network)
- `list_world` — show world structure

**Self-modification:**
- `propose_self_edit` — propose changes to SELF.md
- `apply_self_edit` — apply a validated proposal

**Memory:**
- `search_memory` — FTS5 full-text search over all past interactions
- `synthesize` — cross-reference memory for patterns and contradictions
- `journal` — record thoughts, hypotheses, lessons (with tags)

**Delegation:**
- `spawn_subroutine` — delegate to sub-process (max depth 3)

### Memory
SQLite FTS5 with Porter stemming. Everything is stored:
- User messages
- Model responses
- Tool calls and results (including denials)
- Reflection insights
- Journal entries
- Autonomous actions
- Self-edit proposals and applications

Everything is searchable. Memory persists across sessions.

### Containment

| Vector | Method |
|--------|--------|
| Path traversal (`../`) | `path.resolve` + `startsWith` check |
| Symlink escape | `fs.realpathSync` before every I/O operation |
| macOS `/var` → `/private/var` | `SANDBOX_REAL` normalization |
| Environment leak | Minimal `env` whitelist in `execSync` |
| Network access | Command whitelist (no curl, wget, nc, ssh) |
| Command chaining | Blocked `;`, `|`, `&`, `$()`, backticks |
| World file overwrite | `write_file` blocked for SELF.md / WORLD_LAWS.md |
| Self-edit escape | Forbidden patterns + required core fragment checks |

## Files

- `super.ts` — the entire runtime (~900 lines)
- `sandbox/` — world root, created at boot with seeded world files
- `memory.db` — SQLite FTS5 database, persists across runs
- `__tests__/containment.test.ts` — 44 containment tests
- `__tests__/self-edit.test.ts` — 59 self-modification tests

## Tests

```sh
npx tsx __tests__/containment.test.ts   # 44 tests — path, symlink, network, env, self-edit policy
npx tsx __tests__/self-edit.test.ts     # 59 tests — propose, apply, version, reject, persist
```
