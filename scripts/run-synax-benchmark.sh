#!/usr/bin/env bash
# run-synax-benchmark.sh — Run a single Synax benchmark trial.
#
# Copies the auto-research fixture to a temp workdir, runs Synax against
# the benchmark prompt with a timeout, collects all artifacts, runs the
# deterministic scorer, and writes score.json.
#
# Usage:
#   scripts/run-synax-benchmark.sh <run-id> <artifacts-dir> [--timeout-seconds N] [--synax-cmd CMD]
#
# Environment variables (fallback when CLI flags are absent):
#   SYNAX_BENCH_TIMEOUT        Default timeout seconds (default: 300)
#   SYNAX_CMD                  Path to Synax CLI (default: node dist/cli.js from repo root)
#   SYNAX_BENCH_MODEL          Model name for generated .synax.toml
#   SYNAX_BENCH_BASE_URL       OpenAI-compatible base URL
#   SYNAX_BENCH_API_KEY        API key
#
# Output artifacts in <artifacts-dir>/<run-id>/:
#   transcript.txt          Full stdout+stderr from Synax
#   session-index.json      Copy of ~/.local/share/synax/sessions/index.json (if it exists)
#   session-events.jsonl    Copy of session event log (if session ID detectable)
#   history.db              Copy of EventStore SQLite DB (if available)
#   context.json            Copy of .synax/context.json from workdir
#   workdir-snapshot.txt    File listing from workdir after run
#   test-output.txt         Test run output (npm test)
#   score.json              Deterministic score (written by the scorer)
#   meta.json               Run metadata

set -euo pipefail

# ─── Argument parsing ───────────────────────────────────────
RUN_ID="${1:?Usage: $0 <run-id> <artifacts-dir> [--timeout-seconds N] [--synax-cmd CMD]}"
ARTIFACTS_PARENT="${2:?Usage: $0 <run-id> <artifacts-dir> [--timeout-seconds N] [--synax-cmd CMD]}"
shift 2

TIMEOUT_SECONDS="${SYNAX_BENCH_TIMEOUT:-300}"
SYNAX_CMD="${SYNAX_CMD:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout-seconds)
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --synax-cmd)
      SYNAX_CMD="$2"
      shift 2
      ;;
    *)
      echo "Unknown flag: $1"
      exit 1
      ;;
  esac
done

# ─── Resolve paths ──────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Normalize artifacts parent to an absolute path so later cd operations do not
# change the meaning of ARTIFACTS_DIR or WORKDIR.
if [[ "$ARTIFACTS_PARENT" = /* ]]; then
  ARTIFACTS_PARENT_ABS="$ARTIFACTS_PARENT"
else
  ARTIFACTS_PARENT_ABS="$REPO_ROOT/${ARTIFACTS_PARENT#./}"
fi

ARTIFACTS_DIR="$ARTIFACTS_PARENT_ABS/$RUN_ID"
FIXTURE_SRC="$REPO_ROOT/benchmarks/synax-auto-research/fixture"
SCORER="$REPO_ROOT/scripts/score-synax-benchmark.mjs"

# Default Synax command: use the built dist/cli.js
if [ -z "$SYNAX_CMD" ]; then
  SYNAX_CMD="node $REPO_ROOT/dist/cli.js"
fi

# ─── Validate prerequisites ─────────────────────────────────
if [ ! -d "$FIXTURE_SRC" ]; then
  echo "[run-bench] ERROR: fixture directory not found: $FIXTURE_SRC"
  exit 1
fi

if [ ! -f "$SCORER" ]; then
  echo "[run-bench] ERROR: scorer not found: $SCORER"
  exit 1
fi

if [ ! -f "$REPO_ROOT/dist/cli.js" ] && [[ "$SYNAX_CMD" == *"dist/cli.js"* ]]; then
  echo "[run-bench] Synax not built. Building..."
  (cd "$REPO_ROOT" && npm run build) || {
    echo "[run-bench] ERROR: build failed"
    exit 1
  }
fi

# ─── Setup artifact directory ───────────────────────────────
mkdir -p "$ARTIFACTS_DIR"

# ─── Setup workdir ──────────────────────────────────────────
WORKDIR="$ARTIFACTS_DIR/workdir"
rm -rf "$WORKDIR"
cp -r "$FIXTURE_SRC" "$WORKDIR"

cd "$WORKDIR"

# Use the repo's existing Synax config so benchmark runs match the real setup.
# This preserves the configured remote GPU endpoint and required headers.
if [ -f "$REPO_ROOT/.synax.toml" ]; then
  cp "$REPO_ROOT/.synax.toml" ".synax.toml"
else
  echo "[run-bench] ERROR: repo Synax config not found: $REPO_ROOT/.synax.toml"
  exit 1
fi

# Initialize git in the workdir after config is present, so Synax starts from
# a clean fixture baseline and only task-related changes appear as diffs.
git init --quiet
git config user.email "benchmark@synax.local"
git config user.name "Synax Benchmark"
git add -A
git commit -m "initial fixture state" --quiet

# ─── Benchmark prompt ───────────────────────────────────────
# The task: implement validateEmail so tests pass.
BENCHMARK_PROMPT="Implement the validateEmail function in src/validate-email.js. The exported function should accept an email string and return true for valid emails and false for invalid ones. Run 'node test/validate-email.test.js' to check your work. All tests must pass."

# ─── Capture pre-run state ──────────────────────────────────
SESSION_INDEX_PATH="$HOME/.local/share/synax/sessions/index.json"
PRE_RUN_SESSION_INDEX_FILE="$ARTIFACTS_DIR/pre-session-index.json"
if [ -f "$SESSION_INDEX_PATH" ]; then
  cp "$SESSION_INDEX_PATH" "$PRE_RUN_SESSION_INDEX_FILE" 2>/dev/null || true
fi

# ─── Run Synax with timeout ──────────────────────────────────
TRANSCRIPT_FILE="$ARTIFACTS_DIR/transcript.txt"
START_EPOCH=$(date +%s)
RUN_EXIT=0

echo "[run-bench] Starting Synax run $RUN_ID at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[run-bench] Timeout: ${TIMEOUT_SECONDS}s"
echo "[run-bench] Prompt: $BENCHMARK_PROMPT"
echo "[run-bench] Workdir: $WORKDIR"

if command -v timeout &>/dev/null; then
  # Linux: GNU timeout
  cd "$WORKDIR" && timeout "$TIMEOUT_SECONDS" bash -c "$SYNAX_CMD run -t \"$BENCHMARK_PROMPT\" -y --log-level debug" > "$TRANSCRIPT_FILE" 2>&1 || RUN_EXIT=$?
elif command -v perl &>/dev/null; then
  # macOS: perl alarm-based timeout
  cd "$WORKDIR" && perl -e 'alarm shift; exec @ARGV' "$TIMEOUT_SECONDS" \
    bash -c "$SYNAX_CMD run -t \"$BENCHMARK_PROMPT\" -y --log-level debug" > "$TRANSCRIPT_FILE" 2>&1 || RUN_EXIT=$?
else
  # No timeout tool available — run without timeout (not recommended for long runs)
  cd "$WORKDIR" && bash -c "$SYNAX_CMD run -t \"$BENCHMARK_PROMPT\" -y --log-level debug" > "$TRANSCRIPT_FILE" 2>&1 || RUN_EXIT=$?
fi

END_EPOCH=$(date +%s)
DURATION_SECONDS=$((END_EPOCH - START_EPOCH))
TIMED_OUT=false
if [ "$RUN_EXIT" -eq 124 ] || [ "$RUN_EXIT" -eq 142 ]; then
  TIMED_OUT=true
fi

echo "[run-bench] Synax exited with code $RUN_EXIT after ${DURATION_SECONDS}s"

# ─── Collect artifacts ───────────────────────────────────────

# 1. Copy session index (post-run)
SESSION_INDEX_FILE="$ARTIFACTS_DIR/session-index.json"
if [ -f "$SESSION_INDEX_PATH" ]; then
  cp "$SESSION_INDEX_PATH" "$SESSION_INDEX_FILE" 2>/dev/null || true
fi

# 2. Detect the session ID from the new sessions and copy event log
if [ -f "$PRE_RUN_SESSION_INDEX_FILE" ] && [ -f "$SESSION_INDEX_FILE" ]; then
  # Find sessions that weren't in the pre-run index
  NEW_SESSION_ID=$(python3 -c "
import json
pre = set()
post = set()
try:
  with open('$SESSION_INDEX_FILE') as f:
    post_data = json.load(f)
    post = {s['id'] for s in post_data.get('sessions', [])}
except: pass
try:
  with open('$PRE_RUN_SESSION_INDEX_FILE') as f:
    pre_data = json.load(f)
    pre = {s['id'] for s in pre_data.get('sessions', [])}
except: pass
new = post - pre
if new:
  print(list(new)[0])
" 2>/dev/null || true)
elif [ -f "$SESSION_INDEX_FILE" ]; then
  # No pre-run index — grab the latest session
  NEW_SESSION_ID=$(python3 -c "
import json
with open('$SESSION_INDEX_FILE') as f:
  data = json.load(f)
sessions = sorted(data.get('sessions', []), key=lambda s: s.get('createdAt', ''), reverse=True)
if sessions:
  print(sessions[0]['id'])
" 2>/dev/null || true)
fi

# Copy session event log
if [ -n "${NEW_SESSION_ID:-}" ]; then
  SESSION_YEAR="${NEW_SESSION_ID:0:4}"
  SESSION_MONTH="${NEW_SESSION_ID:4:2}"
  SESSION_EVENTS_SRC="$HOME/.local/share/synax/sessions/sessions/$SESSION_YEAR/$SESSION_MONTH/${NEW_SESSION_ID}.jsonl"
  if [ -f "$SESSION_EVENTS_SRC" ]; then
    cp "$SESSION_EVENTS_SRC" "$ARTIFACTS_DIR/session-events.jsonl" 2>/dev/null || true
  fi
  echo "$NEW_SESSION_ID" > "$ARTIFACTS_DIR/session-id.txt"
fi

# 3. Copy EventStore SQLite DB
EVENT_STORE_PATH="${SYNAX_EVENT_STORE_PATH:-$HOME/.local/share/synax/history.db}"
if [ -f "$EVENT_STORE_PATH" ]; then
  cp "$EVENT_STORE_PATH" "$ARTIFACTS_DIR/history.db" 2>/dev/null || true
fi

# 4. Copy .synax context state from workdir
if [ -f "$WORKDIR/.synax/context.json" ]; then
  cp "$WORKDIR/.synax/context.json" "$ARTIFACTS_DIR/context.json" 2>/dev/null || true
fi

# 5. File listing snapshot of workdir (excluding .git and node_modules)
find "$WORKDIR" -not -path '*/.git/*' -not -path '*/node_modules/*' -type f \
  -exec ls -la {} \; > "$ARTIFACTS_DIR/workdir-snapshot.txt" 2>/dev/null || true

# 6. Show git diff of changes Synax made
cd "$WORKDIR"
git diff > "$ARTIFACTS_DIR/git-diff.txt" 2>/dev/null || true
git status > "$ARTIFACTS_DIR/git-status.txt" 2>/dev/null || true

# 7. Run tests and capture output
echo "[run-bench] Running tests..."
cd "$WORKDIR"
if node test/validate-email.test.js > "$ARTIFACTS_DIR/test-output.txt" 2>&1; then
  TEST_EXIT_CODE=0
else
  TEST_EXIT_CODE=$?
fi
echo "$TEST_EXIT_CODE" > "$ARTIFACTS_DIR/test-exit-code.txt"

# ─── Write meta.json ────────────────────────────────────────
cat > "$ARTIFACTS_DIR/meta.json" <<METAEOF
{
  "runId": "$RUN_ID",
  "startedAt": "$(date -u -r "$START_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)",
  "durationSeconds": $DURATION_SECONDS,
  "synaxExitCode": $RUN_EXIT,
  "testExitCode": $TEST_EXIT_CODE,
  "timedOut": $TIMED_OUT,
  "timeoutSeconds": $TIMEOUT_SECONDS,
  "synaxCmd": "$SYNAX_CMD",
  "workdir": "$WORKDIR"
}
METAEOF

# ─── Run scorer ─────────────────────────────────────────────
echo "[run-bench] Running scorer..."
node "$SCORER" "$ARTIFACTS_DIR"

echo "[run-bench] Run $RUN_ID complete. Artifacts: $ARTIFACTS_DIR"
echo "[run-bench] Score: $(cat "$ARTIFACTS_DIR/score.json" 2>/dev/null || echo 'unknown')"
