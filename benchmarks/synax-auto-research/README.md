# Synax Auto-Research Benchmark Harness

A local, deterministic, self-improvement loop for Synax. Pi+DeepSeek reads
benchmark artifacts and patches Synax product code. Synax+Gemma is benchmarked
against the mini-shell fixture. The harness commits only accepted improvements.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   auto-research-loop.sh                       │
│                                                               │
│  1. Run baseline: Synax+Gemma → mini-shell fixture            │
│     └─ run-synax-benchmark.sh (score + artifacts)            │
│                                                               │
│  2. For each iteration:                                       │
│     ├─ Pi+DeepSeek reads artifacts (run-pi-improvement-agent) │
│     ├─ Forbidden-path check (harness/fixtures untouched)      │
│     ├─ Verify gate: npm run verify (cheap deterministic check) │
│     ├─ Candidate benchmark: Synax+Gemma → mini-shell           │
│     ├─ Score comparison                                       │
│     ├─ If improved: git commit                                │
│     └─ If not: restore tracked + clean untracked agent files  │
│                                                               │
│  Stop when: max-iterations, max-wall-minutes, max-accepted,    │
│    max-rejected, patience, stop-file, or dry-run              │
└──────────────────────────────────────────────────────────────┘

Pi+DeepSeek    →  improves Synax (reads artifacts, patches src/)
Synax+Gemma    →  is benchmarked (never modifies itself)
Harness        →  commits only accepted improvements, reverts failures
```

## One-Command Run (Recommended)

```sh
bash scripts/run-mini-shell-auto-research.sh
```

This starts a long unattended run with sensible defaults:
- Fixture: mini-shell
- Benchmark subject: Synax + Gemma (thinking=off)
- Improvement agent: Pi + DeepSeek (openrouter, 15-min timeout)
- Max iterations: 20
- Max wall minutes: 240 (4 hours)
- Min improvement: 0.05
- Patience: 5
- Cooldown: 10 seconds
- Artifacts: ./benchmark-artifacts

## Manual Equivalent

```sh
export PI_AUTO_RESEARCH_PROVIDER=openrouter
export PI_AUTO_RESEARCH_MODEL=deepseek/deepseek-v4-pro:high
export PI_AUTO_RESEARCH_TIMEOUT_SECONDS=900
export SYNAX_BENCH_THINKING=off

bash scripts/auto-research-loop.sh \
  --max-iterations 20 \
  --max-wall-minutes 240 \
  --timeout-seconds 300 \
  --artifacts-dir ./benchmark-artifacts \
  --agent-cmd "bash scripts/run-pi-improvement-agent.sh" \
  --fixture mini-shell \
  --patience 5 \
  --min-improvement 0.05 \
  --cooldown-seconds 10
```

## How to Stop

| Method | How |
|--------|-----|
| **Stop file** | `touch .auto-research-stop` — clean exit at next iteration |
| **Ctrl-C** | Immediate interrupt (may leave working tree dirty) |
| **Max wall minutes** | Loop auto-stops after N minutes (default: 240) |
| **Max accepted** | Loop auto-stops after N accepted patches |
| **Max rejected** | Loop auto-stops after N rejected/no-change iterations |
| **Stop on perfect** | Loop auto-stops after N consecutive perfect scores (default: 2) |

The stop file is checked at the start of *every iteration*. Once detected,
the loop prints the stop reason and exits cleanly without running the agent.

## Safety Model

### Forbidden Paths

The improvement agent (Pi) is instructed NOT to edit these paths, and the
harness **enforces** this regardless:

- `benchmark-artifacts/` — loop output
- `benchmarks/synax-auto-research/fixtures/` — benchmark tests/prompts
- `benchmarks/synax-auto-research/README.md`
- `benchmarks/synax-auto-research/improvement-agent-prompt.md`
- `scripts/run-synax-benchmark.sh`
- `scripts/score-synax-benchmark.mjs`
- `scripts/auto-research-loop.sh`
- `scripts/run-pi-improvement-agent.sh`
- `package-lock.json` (unless already dirty before loop start)

If forbidden paths are changed, the candidate is rejected **without** running
the benchmark. This prevents the agent from "winning" by editing the scorer,
fixtures, or harness.

Override: `--allow-harness-edits` disables this check.

### Clean Repo Requirement

The loop refuses to start on a dirty repo. Use `--allow-dirty` at your own risk
— uncommitted changes will be committed if the loop accepts patches.

### Pre-Benchmark Verify Gate

Every candidate patch must pass `npm run verify` (typecheck + lint + format:check + build + test)
before the expensive candidate benchmark runs. This is a cheap deterministic gate:

- **If verify passes**: proceed to candidate benchmark as normal.
- **If verify fails**: candidate is rejected immediately — no candidate benchmark is run.
  The rejection reason is recorded as `verify_failed`. Stdout/stderr are saved to
  `iter-N/verify-output.txt`.

This prevents spending 2+ minutes on a candidate benchmark when the patch doesn't
even typecheck or pass tests.

### Conservative Acceptance

A candidate is accepted ONLY if:
- `npm run verify` passed (checked before benchmark)
- `candidateTotal >= baselineTotal + minImprovement` (default min: 0.05)
- AND `candidateTestPassRate > baselineTestPassRate`

The scorer and acceptance rule are deterministic. No LLM is involved in the decision.

### Artifact Logging

Every iteration writes:
- `result.json` — full iteration result with scores, timings, exit codes
- `pi-agent-prompt.md` — the exact prompt sent to Pi
- `pi-agent-output.txt` — Pi's stdout/stderr
- `agent-report.md` — Pi's own report (if it writes one)
- `cleanup-report.txt` — what untracked files were removed after rejection

### Timeout Wrapper

Pi is wrapped with `scripts/with-timeout.sh` (configurable via
`PI_AUTO_RESEARCH_TIMEOUT_SECONDS`, default 900s). This prevents a single
agent invocation from hanging the loop indefinitely. The wrapper tries:
1. `gtimeout` (macOS coreutils)
2. `timeout` (GNU/Linux)
3. `perl alarm` (macOS built-in)

## How to Inspect Results

All artifacts are under the loop directory (e.g., `./benchmark-artifacts/loop-YYYYMMDD-HHMMSS/`):

| File | Contents |
|------|----------|
| `loop-state.json` | Full loop state: start time, stop reason, best scores, all iteration summaries |
| `iter-N/result.json` | Per-iteration: scores, accept/reject, verify status, timings, changed files, commit SHA |
| `iter-N/verify-output.txt` | stdout/stderr from `npm run verify` (only when verify ran) |
| `iter-N/pi-agent-output.txt` | Pi agent stdout/stderr |
| `iter-N/pi-agent-prompt.md` | Exact prompt sent to Pi (with artifact paths) |
| `iter-N/agent-report.md` | Pi's own analysis (if it wrote one) |
| `iter-N/cleanup-report.txt` | What untracked files were removed after rejection |
| `baseline-iter-0/score.json` | Baseline benchmark score |
| `baseline-iter-0/transcript.txt` | Synax+Gemma terminal output |
| `baseline-iter-0/test-output.txt` | Test results from the fixture |
| `baseline-iter-0/git-diff.txt` | What Synax changed in the fixture |
| `iter-iter-N/score.json` | Candidate benchmark score |

## Files

```
benchmarks/synax-auto-research/
  README.md                         This file
  improvement-agent-prompt.md       Prompt for the Pi improvement agent
  fixtures/                         Benchmark task repos
    mini-shell/                     C Unix shell skeleton (primary target)
    validate-email/                 Smoke test: implement validateEmail
    todo-cli-json/                  Smoke test: add --json flag to todo CLI

scripts/
  auto-research-loop.sh             Orchestration loop
  run-synax-benchmark.sh            Run one benchmark trial
  score-synax-benchmark.mjs         Deterministic scorer
  run-pi-improvement-agent.sh       Pi invocation wrapper
  run-mini-shell-auto-research.sh   One-command launcher
  with-timeout.sh                   Process timeout wrapper
```

## Benchmark Fixtures

### mini-shell (primary target)

Synax is given a C Unix shell skeleton with most features missing. Only simple
external commands and exit status work initially (2/7 tests pass). This
benchmark tests whether a local model agent can make meaningful partial
progress on a multi-feature C codebase under a 5-minute timeout.

Synax must implement (in priority order):
1. `cd` and `pwd` builtins
2. Quoted argument parsing (single and double quotes)
3. Environment variable expansion (`$VAR` and `"$VAR"`)
4. Output redirection (`>` and `>>`)
5. Pipeline support (`|`)

**Recommended config**: Disable thinking (`SYNAX_BENCH_THINKING=off`) to
prevent over-planning and timeout.

Baseline: 2/7 tests pass, score around 0.52.

### validate-email (smoke test)

Simple JS project: implement `validateEmail`. 14 tests.

### todo-cli-json (smoke test)

Tiny CLI project: add `--json` flag to output. 10 tests.

## Usage

### Single Benchmark Trial

```sh
# mini-shell (primary target, thinking off recommended)
SYNAX_BENCH_THINKING=off bash scripts/run-synax-benchmark.sh trial-1 ./benchmark-artifacts --fixture mini-shell

# validate-email (smoke test)
bash scripts/run-synax-benchmark.sh trial-1 ./benchmark-artifacts --fixture validate-email

# With custom model config
SYNAX_BENCH_MODEL=qwen3-gguf SYNAX_BENCH_PROVIDER=relay \
  bash scripts/run-synax-benchmark.sh trial-1 ./benchmark-artifacts --fixture mini-shell
```

### Dry-Run (test the loop without real agent)

```sh
bash scripts/auto-research-loop.sh \
  --max-iterations 1 \
  --timeout-seconds 120 \
  --artifacts-dir ./benchmark-artifacts \
  --agent-cmd "bash -lc 'echo no-op agent; exit 0'" \
  --dry-run \
  --fixture mini-shell
```

### Loop Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--max-iterations` | yes | — | Maximum loop iterations |
| `--timeout-seconds` | no | `300` | Timeout per benchmark trial |
| `--artifacts-dir` | yes | — | Artifact storage directory |
| `--agent-cmd` | yes | — | Improvement agent command |
| `--synax-cmd` | no | `node dist/cli.js` | Synax CLI path |
| `--fixture` | no | `validate-email` | Fixture name |
| `--dry-run` | no | `false` | Exercise flow without agent/git |
| `--patience` | no | `1` | Stop after N no-improvement iterations |
| `--min-improvement` | no | `0.05` | Min total score delta to accept |
| `--max-wall-minutes` | no | unset | Stop after N wall-clock minutes |
| `--max-accepted` | no | unset | Stop after N accepted patches |
| `--max-rejected` | no | unset | Stop after N rejected/no-change iterations |
| `--cooldown-seconds` | no | `0` | Sleep between iterations |
| `--stop-file` | no | `.auto-research-stop` | Path to stop signal file |
| `--allow-dirty` | no | `false` | Allow running on dirty repo |
| `--allow-harness-edits` | no | `false` | Disable forbidden-path protection |
| `--stop-on-perfect` | no | `2` | Stop after N consecutive perfect scores (0 disables) |

### Environment Variables (run-pi-improvement-agent.sh)

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_AUTO_RESEARCH_PROVIDER` | `openrouter` | Pi provider |
| `PI_AUTO_RESEARCH_MODEL` | `deepseek/deepseek-v4-pro:high` | Pi model |
| `PI_AUTO_RESEARCH_TOOLS` | `read,bash,edit,write,grep,find,ls` | Pi tool allowlist |
| `PI_AUTO_RESEARCH_TIMEOUT_SECONDS` | `900` | Pi process timeout |
| `PI_AUTO_RESEARCH_EXTRA_ARGS` | — | Extra args passed to pi |

## Scoring Details

The scorer (`scripts/score-synax-benchmark.mjs`) produces `score.json`:

```json
{
  "total": 0.52,
  "breakdown": {
    "testPassRate": 0.286,
    "allTestsPass": 0,
    "noTimeout": 1,
    "filesChanged": 1,
    "finalAnswer": 1,
    "readBeforeEdit": 1,
    "toolErrorRate": 0.9,
    "cleanExit": 1
  }
}
```

Weights: testPassRate 0.30, allTestsPass 0.20, noTimeout 0.15, readBeforeEdit 0.10,
filesChanged 0.10, finalAnswer 0.05, toolErrorRate 0.05, cleanExit 0.05.

## Known Limitations

- **Benchmark variance**: Gemma runs are stochastic. A passing score may not
  reproduce on the next run. This can cause false rejections.
- **Pi may still loop**: If the provider/model behaves badly, Pi may not exit
  cleanly. The process timeout (default 900s) limits this.
- **Acceptance is only as good as the objective**: The scorer weights may not
  perfectly capture real improvement. A patch may improve Synax without improving
  the benchmark score.
- **Local model may be stochastic**: Gemma output varies between runs even with
  identical inputs. Run multiple trials for statistical confidence.
- **Pi needs API access**: The improvement agent requires an OpenRouter API key
  (or other provider) for DeepSeek. Set `OPENROUTER_API_KEY` in your environment.
