#!/usr/bin/env bash
# auto-research-loop.sh — Self-improvement loop for Synax.
#
# Repeatedly:
#   1. Run a benchmark trial to establish/update the baseline score.
#   2. Run an external improvement agent that reads artifacts and applies
#      exactly one code patch to Synax.
#   3. Rerun the benchmark trial.
#   4. Compare the new score against the baseline.
#   5. If improved: git commit the patch with a message including old/new scores.
#      If not improved or failed: git restore tracked files to HEAD.
#
# Stop conditions:
#   - Max iterations reached (--max-iterations)
#   - No score improvement for N consecutive iterations (--patience, default: 1)
#   - Dry-run mode (--dry-run): skip the actual agent invocation and git operations
#
# Usage:
#   scripts/auto-research-loop.sh \
#     --max-iterations 5 \
#     --timeout-seconds 300 \
#     --artifacts-dir ./benchmark-artifacts \
#     --agent-cmd "synax run -t \"\$(cat improve-prompt.md)\" -y" \
#     [--synax-cmd "node dist/cli.js"] \
#     [--dry-run] \
#     [--patience 1]
#
# Environment variables (defaults):
#   SYNAX_BENCH_MODEL          Model name (default: local)
#   SYNAX_BENCH_BASE_URL       Base URL (default: http://localhost:8080/v1)
#   SYNAX_BENCH_API_KEY        API key (default: not-needed)

set -euo pipefail

# ─── Argument parsing ───────────────────────────────────────
MAX_ITERATIONS=""
TIMEOUT_SECONDS="300"
ARTIFACTS_DIR=""
AGENT_CMD=""
SYNAX_CMD=""
DRY_RUN=false
PATIENCE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-iterations)
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    --timeout-seconds)
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --artifacts-dir)
      ARTIFACTS_DIR="$2"
      shift 2
      ;;
    --agent-cmd)
      AGENT_CMD="$2"
      shift 2
      ;;
    --synax-cmd)
      SYNAX_CMD="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --patience)
      PATIENCE="$2"
      shift 2
      ;;
    *)
      echo "Unknown flag: $1"
      echo "Usage: $0 --max-iterations N --timeout-seconds N --artifacts-dir DIR --agent-cmd CMD [--synax-cmd CMD] [--dry-run] [--patience N]"
      exit 1
      ;;
  esac
done

# Validate required args
if [ -z "$MAX_ITERATIONS" ] || [ -z "$ARTIFACTS_DIR" ] || [ -z "$AGENT_CMD" ]; then
  echo "ERROR: --max-iterations, --artifacts-dir, and --agent-cmd are required."
  echo "Usage: $0 --max-iterations N --timeout-seconds N --artifacts-dir DIR --agent-cmd CMD [--synax-cmd CMD] [--dry-run] [--patience N]"
  exit 1
fi

# ─── Resolve paths ──────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_SCRIPT="$REPO_ROOT/scripts/run-synax-benchmark.sh"
IMPROVEMENT_PROMPT="$REPO_ROOT/benchmarks/synax-auto-research/improvement-agent-prompt.md"

# Make artifacts dir absolute if relative
if [[ "$ARTIFACTS_DIR" != /* ]]; then
  ARTIFACTS_DIR="$REPO_ROOT/$ARTIFACTS_DIR"
fi

mkdir -p "$ARTIFACTS_DIR"

# ─── Validate prerequisites ─────────────────────────────────
if [ ! -f "$BENCH_SCRIPT" ]; then
  echo "ERROR: Benchmark script not found: $BENCH_SCRIPT"
  exit 1
fi

if [ ! -f "$IMPROVEMENT_PROMPT" ]; then
  echo "ERROR: Improvement prompt not found: $IMPROVEMENT_PROMPT"
  exit 1
fi

# Ensure Synax is built
if [ ! -f "$REPO_ROOT/dist/cli.js" ]; then
  echo "[loop] Synax not built. Building..."
  (cd "$REPO_ROOT" && npm run build) || {
    echo "[loop] ERROR: build failed"
    exit 1
  }
fi

# Default Synax CMD
if [ -z "$SYNAX_CMD" ]; then
  SYNAX_CMD="node $REPO_ROOT/dist/cli.js"
fi

# ─── State variables ────────────────────────────────────────
LOOP_RUN_DIR="$ARTIFACTS_DIR/loop-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOOP_RUN_DIR"

BASELINE_SCORE=0
CURRENT_BEST_SCORE=0
STREAK_WITHOUT_IMPROVEMENT=0
ITERATION=0

# Save the initial HEAD so we can always return if needed
INITIAL_HEAD=$(cd "$REPO_ROOT" && git rev-parse HEAD)

# ─── Helper functions ───────────────────────────────────────

# Run a single benchmark trial and return the score.
# All diagnostic output goes to stderr; only the numeric score goes to stdout.
run_benchmark() {
  local label="$1"
  local run_id="${label}-iter-${ITERATION}"
  local bench_args=(
    "$run_id"
    "$LOOP_RUN_DIR"
    --timeout-seconds "$TIMEOUT_SECONDS"
    --synax-cmd "$SYNAX_CMD"
  )

  echo "[loop] Running benchmark: $label ($run_id)" >&2
  # Run benchmark; diagnostics go to stderr via the bench script's own output
  bash "$BENCH_SCRIPT" "${bench_args[@]}" >&2

  # Read score from the written score.json — this is the ONLY output to stdout
  local score_file="$LOOP_RUN_DIR/$run_id/score.json"
  if [ -f "$score_file" ]; then
    python3 -c "import json; print(json.load(open('$score_file'))['total'])" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

# ─── Main loop ──────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Synax Auto-Research Loop"
echo "  Max iterations:  $MAX_ITERATIONS"
echo "  Timeout:         ${TIMEOUT_SECONDS}s"
echo "  Artifacts:       $LOOP_RUN_DIR"
echo "  Agent command:   $AGENT_CMD"
echo "  Dry run:         $DRY_RUN"
echo "  Patience:        $PATIENCE"
echo "  Initial HEAD:    $INITIAL_HEAD"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Step 0: Establish baseline ──────────────────────────────
echo "[loop] === Establishing baseline ==="
BASELINE_SCORE=$(run_benchmark "baseline")
CURRENT_BEST_SCORE="$BASELINE_SCORE"
echo "[loop] Baseline score: $BASELINE_SCORE"

# Write loop state
cat > "$LOOP_RUN_DIR/loop-state.json" <<EOF
{
  "initialHead": "$INITIAL_HEAD",
  "baselineScore": $BASELINE_SCORE,
  "currentBestScore": $CURRENT_BEST_SCORE,
  "totalIterations": 0,
  "successfulIterations": 0,
  "iterations": []
}
EOF

# ── Iterate ─────────────────────────────────────────────────
while [ "$ITERATION" -lt "$MAX_ITERATIONS" ]; do
  ITERATION=$((ITERATION + 1))
  echo ""
  echo "───────────────────────────────────────────────────────────────"
  echo "[loop] === Iteration $ITERATION / $MAX_ITERATIONS ==="
  echo "[loop] Current best score: $CURRENT_BEST_SCORE"

  # ── Step 1: Run improvement agent ─────────────────────────
  ITER_DIR="$LOOP_RUN_DIR/iter-${ITERATION}"
  mkdir -p "$ITER_DIR"

  if [ "$DRY_RUN" = true ]; then
    echo "[loop] DRY RUN: skipping improvement agent invocation."
    echo "[loop] Would run: cd $REPO_ROOT && $AGENT_CMD"
    # In dry-run mode, create a dummy change to demonstrate the loop.
    # We add a comment to a tracked source file so git restore can clean it up.
    echo "[loop] Creating dummy change to demonstrate score comparison..."
    echo "// auto-research dry-run marker" >> "$REPO_ROOT/src/cli.ts"
  else
    echo "[loop] Running improvement agent..."
    echo "[loop] Agent reads artifacts from: $LOOP_RUN_DIR"

    # Build the agent command with paths to artifacts
    LATEST_BASELINE=$(ls -d "$LOOP_RUN_DIR"/baseline-iter-* 2>/dev/null | sort | tail -1 || echo "")
    AGENT_FULL_CMD="$AGENT_CMD"

    # If the agent command contains template variables, substitute them
    AGENT_FULL_CMD="${AGENT_FULL_CMD//\{ARTIFACTS_DIR\}/$LOOP_RUN_DIR}"
    AGENT_FULL_CMD="${AGENT_FULL_CMD//\{LATEST_BASELINE\}/$LATEST_BASELINE}"
    AGENT_FULL_CMD="${AGENT_FULL_CMD//\{IMPROVEMENT_PROMPT\}/$IMPROVEMENT_PROMPT}"

    echo "[loop] Agent command: $AGENT_FULL_CMD"

    # Run the agent from the repo root
    cd "$REPO_ROOT"
    if ! eval "$AGENT_FULL_CMD"; then
      AGENT_EXIT=$?
      echo "[loop] Improvement agent exited with code $AGENT_EXIT"
      # Agent failure is not fatal — we record it and continue
    fi
  fi

  # ── Step 2: Check if anything actually changed ────────────
  cd "$REPO_ROOT"
  if git diff --quiet && git diff --cached --quiet; then
    echo "[loop] No changes detected after improvement agent. Skipping benchmark rerun."
    STREAK_WITHOUT_IMPROVEMENT=$((STREAK_WITHOUT_IMPROVEMENT + 1))
    if [ "$STREAK_WITHOUT_IMPROVEMENT" -ge "$PATIENCE" ]; then
      echo "[loop] Patience exhausted ($PATIENCE iterations without change). Stopping."
      break
    fi
    continue
  fi

  # Show what changed
  echo "[loop] Changes detected:"
  git diff --stat 2>/dev/null || true

  # ── Step 3: Rerun benchmark with the patch applied ────────
  NEW_SCORE=$(run_benchmark "iter" || echo "0")
  echo "[loop] New score: $NEW_SCORE (baseline: $CURRENT_BEST_SCORE)"

  # ── Step 4: Accept or reject ──────────────────────────────
  # Use numeric comparison via python3 for reliable float comparison
  SCORE_IMPROVED=$(python3 -c "
new = float('$NEW_SCORE' or '0')
old = float('$CURRENT_BEST_SCORE' or '0')
print('true' if new > old else 'false')
")

  ITER_RESULT=""

  if [ "$SCORE_IMPROVED" = "true" ]; then
    echo "[loop] ✓ Score improved: $CURRENT_BEST_SCORE → $NEW_SCORE"

    if [ "$DRY_RUN" = false ]; then
      # Commit the improvement
      git add -A
      git commit -m "auto-research: score improved ${CURRENT_BEST_SCORE} → ${NEW_SCORE} (iteration ${ITERATION})" || {
        echo "[loop] WARNING: git commit failed (no changes to commit?)"
      }
      echo "[loop] Committed improvement."
    else
      echo "[loop] DRY RUN: would commit with message 'auto-research: score improved ${CURRENT_BEST_SCORE} → ${NEW_SCORE}'"
    fi

    CURRENT_BEST_SCORE="$NEW_SCORE"
    STREAK_WITHOUT_IMPROVEMENT=0
    ITER_RESULT="improved"
  else
    echo "[loop] ✗ Score did not improve: $CURRENT_BEST_SCORE → $NEW_SCORE"

    if [ "$DRY_RUN" = false ]; then
      echo "[loop] Reverting changes (git restore tracked files)..."
      git restore .
      # Verify we're clean
      if ! git diff --quiet; then
        echo "[loop] WARNING: working tree still dirty after restore!"
        git checkout -- .
      fi
    else
      echo "[loop] DRY RUN: would revert with 'git restore .'"
    fi

    STREAK_WITHOUT_IMPROVEMENT=$((STREAK_WITHOUT_IMPROVEMENT + 1))
    ITER_RESULT="rejected"
  fi

  # ── Step 5: Record iteration result ───────────────────────
  cat > "$ITER_DIR/result.json" <<EOF
{
  "iteration": $ITERATION,
  "baselineScore": $CURRENT_BEST_SCORE,
  "newScore": $NEW_SCORE,
  "result": "$ITER_RESULT",
  "dryRun": $DRY_RUN,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

  # Update loop state
  python3 -c "
import json
state = json.load(open('$LOOP_RUN_DIR/loop-state.json'))
state['currentBestScore'] = float('$CURRENT_BEST_SCORE')
state['totalIterations'] = $ITERATION
state['iterations'].append({
    'iteration': $ITERATION,
    'baselineScore': float('$CURRENT_BEST_SCORE'),
    'newScore': float('$NEW_SCORE'),
    'result': '$ITER_RESULT'
})
json.dump(state, open('$LOOP_RUN_DIR/loop-state.json', 'w'), indent=2)
"

  # ── Stop condition: patience ─────────────────────────────
  if [ "$STREAK_WITHOUT_IMPROVEMENT" -ge "$PATIENCE" ]; then
    echo "[loop] Patience exhausted ($PATIENCE iterations without improvement). Stopping."
    break
  fi
done

# ─── Final summary ──────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Auto-Research Loop Complete"
echo "  Iterations:       $ITERATION / $MAX_ITERATIONS"
echo "  Baseline score:   $BASELINE_SCORE"
echo "  Final best score: $CURRENT_BEST_SCORE"
echo "  Artifacts:        $LOOP_RUN_DIR"
echo "═══════════════════════════════════════════════════════════════"

# ─── Restore to clean state ─────────────────────────────────
cd "$REPO_ROOT"

if [ "$DRY_RUN" = true ]; then
  # Clean up dry-run dummy changes (only tracked files)
  echo "[loop] Cleaning up dry-run changes..."
  git checkout -- . 2>/dev/null || true
else
  CURRENT_HEAD=$(git rev-parse HEAD)
  if [ "$CURRENT_HEAD" != "$INITIAL_HEAD" ]; then
    echo "[loop] Note: HEAD moved from $INITIAL_HEAD to $CURRENT_HEAD (improvements were committed)."
    echo "[loop] To restore original state: git checkout $INITIAL_HEAD"
  fi
fi
