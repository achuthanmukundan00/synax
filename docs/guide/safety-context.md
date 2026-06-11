# Safety And Context

Synax treats context as a budget and file edits as explicit local operations.

## Context Management

Synax manages context at runtime with deterministic controls:

### Working Context Orientation

After each model turn that involves file reads, Synax injects a compact "WORKING CONTEXT" block
before the next model call. This tells the model:

- Which files have been inspected with their line ranges
- Which files are editable from memory (exact text available)
- Which files need rereading before editing (were truncated)
- Git status/diff inspection state
- Repeated read counts

This replaces the need for the model to remember what it already read, reducing
context waste from redundant inspection.

### Compaction

When estimated context exceeds ~60% of the effective limit, Synax automatically compacts
older messages. Compaction is deterministic (no LLM summarization):

- Stage 1: Normal compaction with dynamic tail sizing
- Stage 2: Reduced tail (60% of stage 1 tail, then 40%)
- Stage 3: Aggressive minimal summary + minimal tail
- Stage 4: Fail-closed — refuses to call the model and returns a budget error

Tool-call/tool-result pairs are kept intact through compaction. XML-format tool calls
are matched correctly.

### Loop Resistance

Duplicate reads are handled with progressive escalation:

1. First duplicate: Returns cached result silently
2. Second duplicate: Returns cached result with guidance to use search or ranges
3. Third duplicate: Hard failure with working context summary — terminates the turn

Different line ranges of the same file are treated as distinct reads.

### Tool Result Compaction

- Small results stay verbatim
- Large file reads are truncated at per-read and per-turn token caps
- When the per-turn cap is exhausted, subsequent reads are omitted entirely
  with zero-token guidance
- Directory listings are returned as compact inventories
- Tool errors stay short and actionable
- Edit safety is preserved: if exact source text was truncated, Synax
  requires a reread before accepting an edit

### Model Message Assembly

Before every model call, Synax builds the message array through a proactive
assembly layer. This runs regardless of whether the budget threshold has been
exceeded:

- **Recent window**: The last N tool turns (default: 3) are kept verbatim —
  tool calls and their results are sent unmodified.
- **Old tool result compaction**: Tool results outside the recent window are
  replaced with compact structured summaries containing path, line ranges,
  token estimates, truncation state, and repeat counts.
- **Non-tool messages**: All user messages, assistant text responses, and
  system messages are preserved verbatim.
- **Protocol validity**: Every compacted tool result retains its `tool_call_id`,
  so the OpenAI tool-call protocol remains valid.

The canonical conversation history is never modified. This layer operates on a
derived view that is sent to the model.

Configure the recent window size per session:

```toml
[agent]
keep_recent_tool_turns = 3  # default
```

### Budget Inspection

```sh
synax inspect --budget     # Show budget configuration
synax inspect --ledger     # Show working context state from last chat session
synax inspect --context    # Show expanded context state (JSON)
```

The `--ledger` output now includes assembly stats: messages in/out, token
estimates before/after assembly, compacted tool result count, and kept recent
turns.

Inside chat:

```txt
/budget     # Quick budget summary
/status     # Full status including files read, git state, checkpoint info
```

### Context Strategy

Control how aggressively Synax compacts conversation context via `[agent] context_strategy`:

- `aggressive` — compact early, keep minimal tail
- `moderate` — compact at ~60% threshold (default)
- `light` — deterministic compaction only, skip summarization
- `none` or `off` — disable all automatic compaction

Override per-run:

```sh
synax run --task "..." --strategy aggressive
```

## Context Budget

The main budget controls are:

| Setting                                       | Default  | Use                                                   |
| --------------------------------------------- | -------- | ----------------------------------------------------- |
| `agent.context_budget_tokens`                 | `131072` | Overall context target for local high-context models  |
| `agent.reserved_output_tokens`                | `8192`   | Output tokens reserved before each model call         |
| `agent.keep_recent_tokens`                    | `20000`  | Verbatim tail preserved when compacting old history   |
| `agent.max_single_read_result_tokens`         | scaled   | Per-read result cap before tool output enters history |
| `agent.max_total_read_result_tokens_per_turn` | scaled   | Per-turn aggregate cap for read result payloads       |
| `agent.max_tool_calls`                        | `96`     | Maximum tool calls per task                           |

When the read caps are not set explicitly, they scale with the effective input
window (context window minus reserved output tokens):

- single read cap: 10% of the effective window, floor `12000`
- per-turn read cap: 35% of the effective window, floor `40000`

For a 131072-token local model this yields the floors (`12288` / `43008`); for a
1M-context model the per-turn read budget grows to roughly `347000` tokens so
long-horizon exploration is not cut off prematurely. Re-reading a range that was
already read this turn is always served from the read cache and does not consume
budget. When the per-turn cap is reached, further new reads are refused with a
recoverable policy error that does not terminate the turn; the agent is steered
toward acting on what it has (edit/write/bash) or recalling earlier reads via
`search_memory`. Set either key explicitly to disable scaling for that cap.

Useful profiles:

| Budget   | Use                                                                                   |
| -------- | ------------------------------------------------------------------------------------- |
| `16000`  | Small or constrained local model                                                      |
| `65536`  | Normal local coding profile                                                           |
| `131072` | High-context local profile when the server was started with a matching context window |

## File Policy

Synax rejects unsafe file paths and generated outputs. It is designed to avoid reading or editing:

- `node_modules/`
- `.git/`
- build outputs
- coverage outputs
- env files
- paths outside the repository

Validated replacement edits emit a patch preview before Synax writes the file. In non-interactive
`synax run --task` sessions, previewed replacement edits are rejected by default; pass `--yes` to accept them for that
run. Direct runner callers can provide an approval callback.
Replacement writes are atomic (temp file + rename), so failed writes do not leave partial file content.
Replacement edits require a prior read of the same file in the current session and exact replacement text from that read.
If a read result was truncated for context safety, Synax will not accept that truncated session as proof for exact replacement edits.
The `run` command constrains tool access with `--mode`:

- `read-only`: read and bash only.
- `patch`: read, write, edit, and bash.
- `verify`: read and bash only, with verification-focused output.
- `docs`: docs-oriented mutation only, still using read-before-edit.

## Bash Policy

Bash is the only model-facing terminal tool:

```toml
[tools.bash]
enabled = true
```

Disable bash to remove model-facing terminal access entirely. Prefer configured verification commands for routine checks.

## Verification

Configure one verification command:

```toml
[verification]
defaultCommand = "bun run typecheck"
```

Run it inside chat:

```txt
/verify
```

`synax run --task` also reports verification state when a command is configured.
Use `--verification-profile quick|full` and `--repair-attempts <n>` to control verification bounds.
`/verify quick` and `/verify full` run the configured verification command with bounded output limits for each profile.

## Dirty Working Trees

Synax exposes git status and diff through bounded read-only tools. It does not reset or clean the repository. Review changes with:

```sh
git status --short
git diff --stat
git diff
```

For run/task safety artifacts, Synax records:

- lazy checkpoints under `.synax/checkpoints/` once the first allowed mutation is about to run
- bounded run logs under `.synax/runs/`
- last Synax-owned edit metadata at `.synax/last-edit.json` for `/undo-last-edit`
