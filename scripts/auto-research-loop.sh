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
# Accept rule (conservative):
#   candidateTotal >= baselineTotal + minImprovement
#   AND candidateTestPassRate > baselineTestPassRate
#
# Stop conditions:
#   - Max iterations reached (--max-iterations)
#   - No score improvement for N consecutive iterations (--patience, default: 1)
#   - Dry-run mode (--dry-run): exercise control flow but skip git operations
#
# Usage:
#   scripts/auto-research-loop.sh \
#     --max-iterations 5 \
#     --timeout-seconds 300 \
#     --artifacts-dir ./benchmark-artifacts \
#     --agent-cmd "synax run -t \"\$(cat improve-prompt.md)\" -y" \
#     [--synax-cmd "node dist/cli.js"] \
#     [--fixture validate-email] \
#     [--dry-run] \
#     [--patience 1] \
#     [--min-improvement 0.05]
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
FIXTURE="${SYNAX_BENCH_FIXTURE:-validate-email}"
PATIENCE=1
MIN_IMPROVEMENT="0.05"

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
    --fixture)
      FIXTURE="$2"
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
    --min-improvement)
      MIN_IMPROVEMENT="$2"
      shift 2
      ;;
    *)
      echo "Unknown flag: $1"
      echo "Usage: $0 --max-iterations N --timeout-seconds N --artifacts-dir DIR --agent-cmd CMD [--synax-cmd CMD] [--fixture NAME] [--dry-run] [--patience N] [--min-improvement FLOAT]"
      exit 1
      ;;
  esac
done

# Validate required args
if [ -z "$MAX_ITERATIONS" ] || [ -z "$ARTIFACTS_DIR" ] || [ -z "$AGENT_CMD" ]; then
  echo "ERROR: --max-iterations, --artifacts-dir, and --agent-cmd are required."
  echo "Usage: $0 --max-iterations N --timeout-seconds N --artifacts-dir DIR --agent-cmd CMD [--synax-cmd CMD] [--dry-run] [--patience N] [--min-improvement FLOAT]"
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

BASELINE_TOTAL=0
BASELINE_TEST_PASS_RATE=0
CURRENT_BEST_TOTAL=0
CURRENT_BEST_TEST_PASS_RATE=0
STREAK_WITHOUT_IMPROVEMENT=0
ITERATION=0

# Save the initial HEAD so we can always return if needed
INITIAL_HEAD=$(cd "$REPO_ROOT" && git rev-parse HEAD)

# ─── Helper functions ───────────────────────────────────────

# Run a single benchmark trial and return score components.
# All diagnostic output goes to stderr; only "total testPassRate" goes to stdout.
run_benchmark() {
  local label="$1"
  local run_id="${label}-iter-${ITERATION}"
  local bench_args=(
    "$run_id"
    "$LOOP_RUN_DIR"
    --timeout-seconds "$TIMEOUT_SECONDS"
    --synax-cmd "$SYNAX_CMD"
    --fixture "$FIXTURE"
  )

  echo "[loop] Running benchmark: $label ($run_id)" >&2
  # Run benchmark; diagnostics go to stderr via the bench script's own output
  bash "$BENCH_SCRIPT" "${bench_args[@]}" >&2

  # Read total and testPassRate from the written score.json
  # Output: "total testPassRate" on stdout (space-separated)
  local score_file="$LOOP_RUN_DIR/$run_id/score.json"
  if [ -f "$score_file" ]; then
    python3 -c "
import json
s = json.load(open('$score_file'))
total = s.get('total', 0)
tpr = s.get('breakdown', {}).get('testPassRate', 0)
print(f'{total} {tpr}')
" 2>/dev/null || echo "0 0"
  else
    echo "0 0"
  fi
}

# ─── Main loop ──────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Synax Auto-Research Loop"
echo "  Max iterations:  $MAX_ITERATIONS"
echo "  Timeout:         ${TIMEOUT_SECONDS}s"
echo "  Artifacts:       $LOOP_RUN_DIR"
echo "  Fixture:         $FIXTURE"
echo "  Agent command:   $AGENT_CMD"
echo "  Dry run:         $DRY_RUN"
echo "  Patience:        $PATIENCE"
echo "  Min improvement: $MIN_IMPROVEMENT"
echo "  Initial HEAD:    $INITIAL_HEAD"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Step 0: Establish baseline ──────────────────────────────
echo "[loop] === Establishing baseline ==="
BASELINE_RESULT=$(run_benchmark "baseline")
BASELINE_TOTAL=$(echo "$BASELINE_RESULT" | cut -d' ' -f1)
BASELINE_TEST_PASS_RATE=$(echo "$BASELINE_RESULT" | cut -d' ' -f2)
CURRENT_BEST_TOTAL="$BASELINE_TOTAL"
CURRENT_BEST_TEST_PASS_RATE="$BASELINE_TEST_PASS_RATE"
echo "[loop] Baseline: total=$BASELINE_TOTAL testPassRate=$BASELINE_TEST_PASS_RATE"

# Write loop state
cat > "$LOOP_RUN_DIR/loop-state.json" <<EOF
{
  "fixture": "$FIXTURE",
  "initialHead": "$INITIAL_HEAD",
  "baselineTotal": $BASELINE_TOTAL,
  "baselineTestPassRate": $BASELINE_TEST_PASS_RATE,
  "currentBestTotal": $CURRENT_BEST_TOTAL,
  "currentBestTestPassRate": $CURRENT_BEST_TEST_PASS_RATE,
  "totalIterations": 0,
  "successfulIterations": 0,
  "minImprovement": $MIN_IMPROVEMENT,
  "iterations": []
}
EOF

# ── Iterate ─────────────────────────────────────────────────
while [ "$ITERATION" -lt "$MAX_ITERATIONS" ]; do
  ITERATION=$((ITERATION + 1))
  echo ""
  echo "───────────────────────────────────────────────────────────────"
  echo "[loop] === Iteration $ITERATION / $MAX_ITERATIONS ==="
  echo "[loop] Current best: total=$CURRENT_BEST_TOTAL testPassRate=$CURRENT_BEST_TEST_PASS_RATE"

  # ── Step 1: Run improvement agent ─────────────────────────
  ITER_DIR="$LOOP_RUN_DIR/iter-${ITERATION}"
  mkdir -p "$ITER_DIR"

  if [ "$DRY_RUN" = true ]; then
    echo "[loop] DRY RUN: skipping improvement agent invocation."
    echo "[loop] Would run: cd $REPO_ROOT && $AGENT_CMD"
    echo "[loop] DRY RUN: no source changes made (dry-run does not mutate files)."
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
    echo "[loop] No changes detected after improvement agent. Skipping candidate benchmark."

    # Record the no-changes result
    cat > "$ITER_DIR/result.json" <<EOF
{
  "iteration": $ITERATION,
  "fixture": "$FIXTURE",
  "baselineTotal": $CURRENT_BEST_TOTAL,
  "candidateTotal": null,
  "baselineTestPassRate": $CURRENT_BEST_TEST_PASS_RATE,
  "candidateTestPassRate": null,
  "minImprovement": $MIN_IMPROVEMENT,
  "accepted": false,
  "rejectReason": "no_changes",
  "dryRun": $DRY_RUN,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

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
  CANDIDATE_RESULT=$(run_benchmark "iter" || echo "0 0")
  CANDIDATE_TOTAL=$(echo "$CANDIDATE_RESULT" | cut -d' ' -f1)
  CANDIDATE_TEST_PASS_RATE=$(echo "$CANDIDATE_RESULT" | cut -d' ' -f2)
  echo "[loop] Candidate: total=$CANDIDATE_TOTAL testPassRate=$CANDIDATE_TEST_PASS_RATE"
  echo "[loop] Baseline:  total=$CURRENT_BEST_TOTAL testPassRate=$CURRENT_BEST_TEST_PASS_RATE"

  # ── Step 4: Accept or reject (conservative rule) ──────────
  # Accept only if:
  #   candidateTotal >= baselineTotal + minImprovement
  #   AND candidateTestPassRate > baselineTestPassRate
  ACCEPTED=$(python3 -c "
candidate_total = float('$CANDIDATE_TOTAL' or '0')
candidate_tpr   = float('$CANDIDATE_TEST_PASS_RATE' or '0')
baseline_total  = float('$CURRENT_BEST_TOTAL' or '0')
baseline_tpr    = float('$CURRENT_BEST_TEST_PASS_RATE' or '0')
min_imp         = float('$MIN_IMPROVEMENT' or '0.05')
eps             = 1e-9

total_ok = candidate_total >= baseline_total + min_imp - eps
tpr_ok   = candidate_tpr > baseline_tpr + eps

if total_ok and tpr_ok:
    print('true')
else:
    print('false')
")

  # Determine reject reason
  REJECT_REASON=""
  if [ "$ACCEPTED" = "true" ]; then
    REJECT_REASON="null"
  else
    TOTAL_OK=$(python3 -c "
candidate_total = float('$CANDIDATE_TOTAL' or '0')
baseline_total  = float('$CURRENT_BEST_TOTAL' or '0')
min_imp         = float('$MIN_IMPROVEMENT' or '0.05')
eps             = 1e-9
print('true' if candidate_total >= baseline_total + min_imp - eps else 'false')
")
    TPR_OK=$(python3 -c "
candidate_tpr = float('$CANDIDATE_TEST_PASS_RATE' or '0')
baseline_tpr  = float('$CURRENT_BEST_TEST_PASS_RATE' or '0')
eps           = 1e-9
print('true' if candidate_tpr > baseline_tpr + eps else 'false')
")
    if [ "$TOTAL_OK" = "false" ] && [ "$TPR_OK" = "false" ]; then
      REJECT_REASON="score_not_improved"
    elif [ "$TOTAL_OK" = "false" ]; then
      REJECT_REASON="total_insufficient_improvement"
    else
      REJECT_REASON="test_pass_rate_not_improved"
    fi
  fi

  ITER_RESULT=""

  if [ "$ACCEPTED" = "true" ]; then
    echo "[loop] ✓ Accepted: total $CURRENT_BEST_TOTAL → $CANDIDATE_TOTAL, tpr $CURRENT_BEST_TEST_PASS_RATE → $CANDIDATE_TEST_PASS_RATE"

    if [ "$DRY_RUN" = false ]; then
      # Commit the improvement
      git add -A
      git commit -m "auto-research [$FIXTURE]: total ${CURRENT_BEST_TOTAL} → ${CANDIDATE_TOTAL}, tpr ${CURRENT_BEST_TEST_PASS_RATE} → ${CANDIDATE_TEST_PASS_RATE} (iteration ${ITERATION})" || {
        echo "[loop] WARNING: git commit failed (no changes to commit?)"
      }
      echo "[loop] Committed improvement."
    else
      echo "[loop] DRY RUN: would commit with message 'auto-research [$FIXTURE]: total ${CURRENT_BEST_TOTAL} → ${CANDIDATE_TOTAL} (iteration ${ITERATION})'"
    fi

    CURRENT_BEST_TOTAL="$CANDIDATE_TOTAL"
    CURRENT_BEST_TEST_PASS_RATE="$CANDIDATE_TEST_PASS_RATE"
    STREAK_WITHOUT_IMPROVEMENT=0
    ITER_RESULT="accepted"
  else
    echo "[loop] ✗ Rejected: $REJECT_REASON (total $CURRENT_BEST_TOTAL → $CANDIDATE_TOTAL, tpr $CURRENT_BEST_TEST_PASS_RATE → $CANDIDATE_TEST_PASS_RATE)"

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
  "fixture": "$FIXTURE",
  "baselineTotal": $CURRENT_BEST_TOTAL,
  "candidateTotal": $CANDIDATE_TOTAL,
  "baselineTestPassRate": $CURRENT_BEST_TEST_PASS_RATE,
  "candidateTestPassRate": $CANDIDATE_TEST_PASS_RATE,
  "minImprovement": $MIN_IMPROVEMENT,
  "accepted": $ACCEPTED,
  "rejectReason": $REJECT_REASON,
  "result": "$ITER_RESULT",
  "dryRun": $DRY_RUN,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

  # Update loop state
  python3 -c "
import json
state = json.load(open('$LOOP_RUN_DIR/loop-state.json'))
state['currentBestTotal'] = float('$CURRENT_BEST_TOTAL')
state['currentBestTestPassRate'] = float('$CURRENT_BEST_TEST_PASS_RATE')
state['totalIterations'] = $ITERATION
state['iterations'].append({
    'iteration': $ITERATION,
    'fixture': '$FIXTURE',
    'baselineTotal': float('$CURRENT_BEST_TOTAL'),
    'candidateTotal': $CANDIDATE_TOTAL,
    'baselineTestPassRate': float('$CURRENT_BEST_TEST_PASS_RATE'),
    'candidateTestPassRate': $CANDIDATE_TEST_PASS_RATE,
    'minImprovement': float('$MIN_IMPROVEMENT'),
    'accepted': $ACCEPTED,
    'rejectReason': $REJECT_REASON,
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
echo "  Fixture:          $FIXTURE"
echo "  Iterations:       $ITERATION / $MAX_ITERATIONS"
echo "  Baseline total:   $BASELINE_TOTAL"
echo "  Baseline tpr:     $BASELINE_TEST_PASS_RATE"
echo "  Final best total: $CURRENT_BEST_TOTAL"
echo "  Final best tpr:   $CURRENT_BEST_TEST_PASS_RATE"
echo "  Artifacts:        $LOOP_RUN_DIR"
echo "═══════════════════════════════════════════════════════════════"

# ─── Restore to clean state ─────────────────────────────────
cd "$REPO_ROOT"

if [ "$DRY_RUN" = false ]; then
  CURRENT_HEAD=$(git rev-parse HEAD)
  if [ "$CURRENT_HEAD" != "$INITIAL_HEAD" ]; then
    echo "[loop] Note: HEAD moved from $INITIAL_HEAD to $CURRENT_HEAD (improvements were committed)."
    echo "[loop] To restore original state: git checkout $INITIAL_HEAD"
  fi
else
  echo "[loop] Dry run complete — no source changes were made."
fi
