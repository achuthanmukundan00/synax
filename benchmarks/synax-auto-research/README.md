# Synax Auto-Research Benchmark Harness

A local, deterministic, self-improvement loop for Synax. The harness repeatedly
runs a fixed benchmark, scores the result, and allows an improvement agent to
apply exactly one code patch — accepting it only if the score improves.

## Design

```
┌──────────────────────────────────────────────────┐
│                  auto-research-loop.sh            │
│                                                   │
│  1. Establish baseline score                      │
│     └─ run-synax-benchmark.sh (trial 0)          │
│                                                   │
│  2. For each iteration:                           │
│     ├─ Run improvement agent (reads artifacts)    │
│     ├─ Rerun benchmark                            │
│     ├─ Compare score                              │
│     ├─ If improved: git commit                    │
│     └─ If not: git restore tracked files         │
│                                                   │
│  Stop when:                                       │
│    - Max iterations reached                       │
│    - Patience exhausted (no improvement streak)   │
└──────────────────────────────────────────────────┘
```

## Safety Model

- **No network required.** The benchmark runs against a local fixture. The scorer
  is a deterministic Node.js script. No external APIs are called.
- **Each run is isolated.** The fixture is copied to a temp workdir with its own
  `.synax.toml` and git repo.
- **Every run has its own artifact directory** with transcript, test output, git
  diff, session logs, event store DB, context state, and score.
- **Accept/reject is deterministic and conservative.** A Node.js script scores
  dimensions (test pass rate, timeout, files changed, read-before-edit, etc.)
  and computes a weighted total. A candidate is accepted only if:
  `candidateTotal >= baselineTotal + minImprovement` (default 0.05)
  **AND** `candidateTestPassRate > baselineTestPassRate`. No LLM is involved
  in the decision.
- **One patch per iteration.** The improvement agent is instructed to make
  exactly one minimal change.
- **Safe revert.** Uses `git restore .` (tracked files only) — never `git clean`.
  This protects untracked benchmark/harness files from accidental deletion.
- **Dry-run mode.** Use `--dry-run` to exercise loop control flow without
  invoking the agent, mutating source files, or making git commits. The loop
  runs the baseline benchmark, skips the agent, detects no changes, and exits
  cleanly without modifying any product code.

## Files

```
benchmarks/synax-auto-research/
  README.md                         This file
  improvement-agent-prompt.md       Prompt for the improvement agent
  fixtures/                         Benchmark task repos
    validate-email/                 Fixture: implement validateEmail
      benchmark-config.json         Prompt, test command, description
      package.json
      src/validate-email.js         Missing function — Synax must implement
      test/validate-email.test.js   Tests that define correctness
    todo-cli-json/                  Fixture: add --json flag to todo CLI
      benchmark-config.json         Prompt, test command, description
      package.json
      src/cli.js                    CLI entrypoint (arg parsing)
      src/todo.js                   Core TodoList with formatList()
      src/storage.js                File-based persistence
      test/todo.test.js             Tests for text + JSON output

scripts/
  run-synax-benchmark.sh            Run one benchmark trial
  score-synax-benchmark.mjs         Deterministic scorer
  auto-research-loop.sh             Orchestration loop
```

## Benchmark Fixtures

### `validate-email`

Synax is given a minimal JavaScript project with one missing feature:
`validateEmail` in `src/validate-email.js`. The project has 14 tests that define
correctness for a simple email validator.

Synax must:
1. Read the source file and tests
2. Implement `validateEmail` correctly
3. Run the tests to verify

### `todo-cli-json`

Synax is given a tiny CLI task tracker with one missing feature: the `--json`
flag on `todo list`. The text output (`todo list`) already works; the JSON
output (`todo list --json`) is missing. The project has 10 tests covering
both text and JSON output.

Synax must:
1. Inspect the CLI entrypoint (`src/cli.js`)
2. Inspect the core module (`src/todo.js`) and storage (`src/storage.js`)
3. Inspect the test file (`test/todo.test.js`)
4. Implement `formatList({ json: true })` to output valid JSON
5. Ensure text output continues to work unchanged
6. Run `npm test` to verify

### `mini-shell`

Synax is given a C Unix shell skeleton with most features missing. Only simple
external commands and exit status work initially (2/7 tests pass). This
benchmark is harder than validate-email or todo-cli-json — it tests whether a
local model agent can make meaningful partial progress on a multi-feature C
codebase under a 5-minute timeout.

Synax must implement (in priority order):
1. `cd` and `pwd` builtins
2. Quoted argument parsing (single and double quotes)
3. Environment variable expansion (`$VAR` and `"$VAR"`)
4. Output redirection (`>` and `>>`)
5. Pipeline support (`|`)

The prompt instructs the agent to edit early, test after each feature, and
deliver partial progress when time is short.

**Recommended config**: Disable thinking for this benchmark — thinking mode
causes large models to over-plan and time out before making any edits:

```sh
SYNAX_BENCH_THINKING=off bash scripts/run-synax-benchmark.sh mini-shell-off-1 ./benchmark-artifacts --fixture mini-shell
```

The scorer checks:
- How many tests passed (weight: 30%)
- Whether all tests passed (weight: 20%)
- Whether Synax completed without timeout (weight: 15%)
- Whether Synax changed source files (weight: 10%)
- Whether Synax read files before editing (weight: 10%)
- Whether Synax produced a final answer (weight: 5%)
- Tool error rate (weight: 5%)
- Clean exit code (weight: 5%)

Total score is a weighted sum, 0–1.

## Usage

### Prerequisites

```sh
# Build Synax
npm run build
```

### Run a Single Benchmark Trial

```sh
# validate-email fixture (default)
bash scripts/run-synax-benchmark.sh trial-1 ./benchmark-artifacts

# validate-email fixture, explicit
bash scripts/run-synax-benchmark.sh trial-1 ./benchmark-artifacts --fixture validate-email

# todo-cli-json fixture
bash scripts/run-synax-benchmark.sh trial-1 ./benchmark-artifacts --fixture todo-cli-json

# mini-shell fixture (C shell skeleton)
bash scripts/run-synax-benchmark.sh trial-1 ./benchmark-artifacts --fixture mini-shell

# mini-shell with thinking disabled (recommended for large-model benchmarks)
SYNAX_BENCH_THINKING=off bash scripts/run-synax-benchmark.sh mini-shell-off-1 ./benchmark-artifacts --fixture mini-shell

# With a custom Synax command and timeout
bash scripts/run-synax-benchmark.sh trial-1 ./benchmark-artifacts \
  --timeout-seconds 120 \
  --synax-cmd "node ./dist/cli.js" \
  --fixture validate-email

# Using environment variables for model configuration
SYNAX_BENCH_MODEL=qwen3-gguf \
SYNAX_BENCH_BASE_URL=http://127.0.0.1:1234/v1 \
SYNAX_BENCH_API_KEY=not-needed \
bash scripts/run-synax-benchmark.sh trial-1 ./benchmark-artifacts \
  --fixture todo-cli-json
```

Artifacts are written to `./benchmark-artifacts/trial-1/`:
```
trial-1/
  transcript.txt              Full Synax stdout+stderr
  prompt.txt                  Exact prompt as passed to Synax
  test-output.txt             Test runner output
  test-exit-code.txt          Exit code from npm test
  score.json                  Deterministic score
  meta.json                   Run metadata
  git-diff.txt                Changes Synax made to the fixture
  git-status.txt              Git status after run
  session-index.json          Copy of session index
  session-events.jsonl        Session event log (if available)
  session-id.txt              Detected session ID
  history.db                  EventStore SQLite DB (if available)
  context.json                Synax context state (if available)
  synax-config-sanitized.toml Sanitized copy of active config
  workdir-snapshot.txt        File listing of workdir
  workdir/                    The actual fixture workdir
```

### Run the Auto-Research Loop

```sh
# Dry-run: test the loop without real agent or git changes
bash scripts/auto-research-loop.sh \
  --max-iterations 3 \
  --timeout-seconds 300 \
  --artifacts-dir ./benchmark-artifacts \
  --agent-cmd "echo 'agent would run here'" \
  --dry-run

# Real run: Synax attempts to improve itself
bash scripts/auto-research-loop.sh \
  --max-iterations 5 \
  --timeout-seconds 300 \
  --artifacts-dir ./benchmark-artifacts \
  --agent-cmd "node dist/cli.js run -t \"\$(cat benchmarks/synax-auto-research/improvement-agent-prompt.md) Read artifacts from {ARTIFACTS_DIR} and the latest baseline at {LATEST_BASELINE}.\" -y" \
  --patience 2

# Quick test with short timeout
bash scripts/auto-research-loop.sh \
  --max-iterations 2 \
  --timeout-seconds 60 \
  --artifacts-dir ./quick-test \
  --agent-cmd "echo 'skipping agent'" \
  --dry-run
```

Template variables in `--agent-cmd`:
- `{ARTIFACTS_DIR}` → resolved path to the artifacts directory
- `{LATEST_BASELINE}` → path to the most recent baseline artifact directory
- `{IMPROVEMENT_PROMPT}` → path to the improvement agent prompt markdown file

### Runner Flags (`run-synax-benchmark.sh`)

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<run-id>` | yes | — | Identifier for this trial (e.g., `trial-1`) |
| `<artifacts-dir>` | yes | — | Parent directory for artifact storage |
| `--timeout-seconds` | no | `300` | Timeout for the Synax run |
| `--synax-cmd` | no | `node dist/cli.js` | Path to Synax CLI |
| `--fixture` | no | `validate-email` | Fixture name: `validate-email` or `todo-cli-json` |

### Loop Flags (`auto-research-loop.sh`)

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--max-iterations` | yes | — | Maximum loop iterations |
| `--timeout-seconds` | no | `300` | Timeout for each benchmark trial |
| `--artifacts-dir` | yes | — | Directory for artifact storage |
| `--agent-cmd` | yes | — | Command to invoke the improvement agent |
| `--synax-cmd` | no | `node dist/cli.js` | Path to Synax CLI |
| `--fixture` | no | `validate-email` | Fixture name to benchmark |
| `--dry-run` | no | `false` | Exercise loop control flow without agent or git changes |
| `--patience` | no | `1` | Stop after N iterations without improvement |
| `--min-improvement` | no | `0.05` | Minimum total score improvement required to accept |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNAX_BENCH_MODEL` | `gemma-4-26B-A4B-it-UD-IQ4_XS.gguf` | Model name for generated `.synax.toml` |
| `SYNAX_BENCH_BASE_URL` | (from repo config) | OpenAI-compatible base URL |
| `SYNAX_BENCH_API_KEY` | (from repo config) | API key |
| `SYNAX_BENCH_PROVIDER` | `relay` | Provider name in `.synax.toml` |
| `SYNAX_BENCH_THINKING` | `high` | Thinking level: `off`, `low`, `medium`, `high`. Use `off` for large-model benchmarks to prevent timeout from over-planning |
| `SYNAX_BENCH_FIXTURE` | `validate-email` | Default fixture name |
| `SYNAX_BENCH_TIMEOUT` | `300` | Fallback timeout seconds |
| `SYNAX_CMD` | — | Fallback Synax command |
| `SYNAX_EVENT_STORE_PATH` | `~/.local/share/synax/history.db` | EventStore DB path (for artifact collection) |

## Manual Fixture Verification

Each fixture is a standalone testable project.

### validate-email

```sh
cd benchmarks/synax-auto-research/fixtures/validate-email

# Tests will fail (validateEmail is missing)
node test/validate-email.test.js
# Expected: 0 passed, 14 failed, 14 total

# After implementing validateEmail in src/validate-email.js,
# tests should all pass:
node test/validate-email.test.js
# Expected: 14 passed, 0 failed, 14 total
```

### todo-cli-json

```sh
cd benchmarks/synax-auto-research/fixtures/todo-cli-json

# Text output tests pass, JSON tests fail (formatList json branch missing)
npm test
# Expected: 4 passed, 6 failed, 10 total

# After implementing formatList({ json: true }) in src/todo.js:
npm test
# Expected: 10 passed, 0 failed, 10 total
```

### mini-shell

```sh
cd benchmarks/synax-auto-research/fixtures/mini-shell

# Baseline: only simple-command and exit-status pass
make test
# Expected: 2 passed, 5 failed, 7 total

# After full implementation:
make test
# Expected: 7 passed, 0 failed, 7 total
```

## Scoring Details

The scorer (`scripts/score-synax-benchmark.mjs`) produces `score.json`:

```json
{
  "total": 0.85,
  "breakdown": {
    "testPassRate": 1.0,
    "allTestsPass": 1,
    "noTimeout": 1,
    "filesChanged": 1,
    "finalAnswer": 1,
    "readBeforeEdit": 0,
    "toolErrorRate": 0.9,
    "cleanExit": 1
  },
  "metadata": {
    "testPassed": 14,
    "testFailed": 0,
    "testTotal": 14,
    "testExitCode": "0",
    "timedOut": false,
    "synaxExitCode": 0,
    "durationSeconds": 45
  }
}
```

## Improvement Agent Contract

The improvement agent (invoked via `--agent-cmd`) receives:
- Read access to all artifact directories under `{ARTIFACTS_DIR}`
- Read/write access to the Synax source tree (`src/`)
- The improvement agent prompt at `benchmarks/synax-auto-research/improvement-agent-prompt.md`

The agent must:
- Read `score.json` and artifacts to identify failure modes
- Apply exactly one minimal patch to Synax source code
- Run `npm run typecheck` to verify
- Exit (never commit — the loop handles git)

The loop:
- Detects if the agent changed any files
- Reruns the benchmark with the patch applied
- Compares scores numerically
- Commits or reverts based on the comparison
