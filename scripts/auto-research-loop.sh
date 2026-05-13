#!/usr/bin/env bash
# auto-research-loop.sh — Self-improvement loop for Synax.
#
# Repeatedly:
#   1. Run a benchmark trial to establish/update the baseline score.
#   2. Run an external improvement agent (Pi+DeepSeek) that reads artifacts
#      and applies exactly one code patch to Synax.
#   3. Rerun the benchmark trial.
#   4. Compare the new score against the baseline.
#   5. If improved: git commit; otherwise restore + clean untracked agent files.
#
# Accept rule (conservative):
#   candidateTotal >= baselineTotal + minImprovement
#   AND candidateTestPassRate > baselineTestPassRate
#
# Stop conditions: max-iterations, max-wall-minutes, max-accepted, max-rejected,
#   patience, stop-file, dry-run.
#
# Usage: see --help or README.

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
MAX_WALL_MINUTES=""
MAX_ACCEPTED=""
MAX_REJECTED=""
COOLDOWN_SECONDS="0"
STOP_FILE=".auto-research-stop"
ALLOW_DIRTY=false
ALLOW_HARNESS_EDITS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-iterations)      MAX_ITERATIONS="$2"; shift 2 ;;
    --timeout-seconds)     TIMEOUT_SECONDS="$2"; shift 2 ;;
    --artifacts-dir)       ARTIFACTS_DIR="$2"; shift 2 ;;
    --agent-cmd)           AGENT_CMD="$2"; shift 2 ;;
    --synax-cmd)           SYNAX_CMD="$2"; shift 2 ;;
    --fixture)             FIXTURE="$2"; shift 2 ;;
    --dry-run)             DRY_RUN=true; shift ;;
    --patience)            PATIENCE="$2"; shift 2 ;;
    --min-improvement)     MIN_IMPROVEMENT="$2"; shift 2 ;;
    --max-wall-minutes)    MAX_WALL_MINUTES="$2"; shift 2 ;;
    --max-accepted)        MAX_ACCEPTED="$2"; shift 2 ;;
    --max-rejected)        MAX_REJECTED="$2"; shift 2 ;;
    --cooldown-seconds)    COOLDOWN_SECONDS="$2"; shift 2 ;;
    --stop-file)           STOP_FILE="$2"; shift 2 ;;
    --allow-dirty)         ALLOW_DIRTY=true; shift ;;
    --allow-harness-edits) ALLOW_HARNESS_EDITS=true; shift ;;
    *)
      echo "Unknown flag: $1"
      echo "Usage: $0 --max-iterations N --timeout-seconds N --artifacts-dir DIR --agent-cmd CMD [...]"
      exit 1 ;;
  esac
done

if [ -z "$MAX_ITERATIONS" ] || [ -z "$ARTIFACTS_DIR" ] || [ -z "$AGENT_CMD" ]; then
  echo "ERROR: --max-iterations, --artifacts-dir, and --agent-cmd are required."
  exit 1
fi

# ─── Resolve paths ──────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_SCRIPT="$REPO_ROOT/scripts/run-synax-benchmark.sh"
IMPROVEMENT_PROMPT="$REPO_ROOT/benchmarks/synax-auto-research/improvement-agent-prompt.md"
if [[ "$ARTIFACTS_DIR" != /* ]]; then ARTIFACTS_DIR="$REPO_ROOT/$ARTIFACTS_DIR"; fi
mkdir -p "$ARTIFACTS_DIR"

[ ! -f "$BENCH_SCRIPT" ] && { echo "ERROR: $BENCH_SCRIPT not found."; exit 1; }
[ ! -f "$IMPROVEMENT_PROMPT" ] && { echo "ERROR: $IMPROVEMENT_PROMPT not found."; exit 1; }

if [ ! -f "$REPO_ROOT/dist/cli.js" ]; then
  echo "[loop] Building Synax..."
  (cd "$REPO_ROOT" && npm run build) || { echo "[loop] Build failed"; exit 1; }
fi
[ -z "$SYNAX_CMD" ] && SYNAX_CMD="node $REPO_ROOT/dist/cli.js"

# ─── Forbidden paths ────────────────────────────────────────
FORBIDDEN_PATHS=(
  "benchmark-artifacts/"
  "benchmarks/synax-auto-research/fixtures/"
  "benchmarks/synax-auto-research/README.md"
  "benchmarks/synax-auto-research/improvement-agent-prompt.md"
  "scripts/run-synax-benchmark.sh"
  "scripts/score-synax-benchmark.mjs"
  "scripts/auto-research-loop.sh"
  "scripts/run-pi-improvement-agent.sh"
)

# ─── State variables ────────────────────────────────────────
LOOP_RUN_DIR="$ARTIFACTS_DIR/loop-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOOP_RUN_DIR"

BASELINE_TOTAL=0; BASELINE_TEST_PASS_RATE=0
CURRENT_BEST_TOTAL=0; CURRENT_BEST_TEST_PASS_RATE=0
STREAK_WITHOUT_IMPROVEMENT=0; ITERATION=0
ACCEPTED_COUNT=0; REJECTED_COUNT=0; NO_CHANGE_COUNT=0; TIMEOUT_COUNT=0
STOP_REASON="max_iterations"
LOOP_START_EPOCH=$(date +%s)
INITIAL_HEAD=$(cd "$REPO_ROOT" && git rev-parse HEAD)

# Conditionally forbid package-lock.json
cd "$REPO_ROOT"
if git diff --quiet -- package-lock.json && git diff --cached --quiet -- package-lock.json; then
  FORBIDDEN_PATHS+=("package-lock.json")
else
  echo "[loop] Note: package-lock.json already modified — excluded from forbidden list."
fi

# ─── Helper: check_forbidden_paths ──────────────────────────
check_forbidden_paths() {
  local changed="" diff_out untracked
  cd "$REPO_ROOT"
  diff_out=$(git diff --name-only 2>/dev/null || true)
  untracked=$(git ls-files --others --exclude-standard 2>/dev/null || true)
  for forbidden in "${FORBIDDEN_PATHS[@]}"; do
    if echo "$diff_out" | grep -qF "$forbidden" 2>/dev/null; then
      changed="$changed $forbidden"; continue
    fi
    if echo "$untracked" | grep -qF "$forbidden" 2>/dev/null; then
      changed="$changed $forbidden"; continue
    fi
    if [ -f "$forbidden" ] || [ -d "$forbidden" ]; then
      if ! git diff --quiet -- "$forbidden" 2>/dev/null; then
        if ! echo "$changed" | grep -qF "$forbidden" 2>/dev/null; then
          changed="$changed $forbidden"
        fi
      fi
    fi
  done
  changed="${changed# }"
  if [ -n "$changed" ]; then echo "$changed"; return 1; fi
  return 0
}

# ─── Helper: cleanup_agent_untracked ────────────────────────
cleanup_agent_untracked() {
  local iter_dir="$1" report="$iter_dir/cleanup-report.txt"
  cd "$REPO_ROOT"
  { echo "# Agent Untracked File Cleanup"; echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo ""; } > "$report"
  local untracked
  untracked=$(git ls-files --others --exclude-standard 2>/dev/null || true)
  if [ -z "$untracked" ]; then
    echo "No untracked files to clean up." >> "$report"
    echo "[loop] No untracked files to clean up."; return 0
  fi
  local removed_any=false
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local full="$REPO_ROOT/$file"
    if [[ "$full" == "$ARTIFACTS_DIR"* ]]; then echo "SKIP (artifact): $file" >> "$report"; continue; fi
    if [[ "$full" == "$REPO_ROOT/.git"* ]]; then echo "SKIP (.git): $file" >> "$report"; continue; fi
    if git check-ignore -q "$file" 2>/dev/null; then echo "SKIP (gitignored): $file" >> "$report"; continue; fi
    echo "REMOVE: $file" >> "$report"
    rm -rf "$full" 2>/dev/null || echo "  FAILED: $file" >> "$report"
    removed_any=true
  done <<< "$untracked"
  [ "$removed_any" = false ] && echo "All untracked files were skipped." >> "$report"
  echo "[loop] Cleanup report: $report"
}

# ─── Helper: check_stop_file ────────────────────────────────
check_stop_file() { [ -f "$REPO_ROOT/$STOP_FILE" ] && return 0; return 1; }

# ─── Helper: update_loop_state ──────────────────────────────
update_loop_state() {
  local result="$1" reject_reason="$2" agent_exit="$3" agent_timed_out="$4"
  local commit_sha="$5" started_at_epoch="$6" candid_total="${7:-None}" candid_tpr="${8:-None}"
  local verify_passed="${9:-None}" verify_exit="${10:-None}"
  local started_at
  started_at=$(date -u -r "$started_at_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
  local rr_json="None"
  [ -n "$reject_reason" ] && [ "$reject_reason" != "null" ] && rr_json="\"$reject_reason\""

  python3 -c "
import json
state = json.load(open('$LOOP_RUN_DIR/loop-state.json'))
state['updatedAt'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
state['currentBestTotal'] = float('$CURRENT_BEST_TOTAL')
state['currentBestTestPassRate'] = float('$CURRENT_BEST_TEST_PASS_RATE')
state['acceptedCount'] = $ACCEPTED_COUNT
state['rejectedCount'] = $REJECTED_COUNT
state['noChangeCount'] = $NO_CHANGE_COUNT
state['timeoutCount'] = $TIMEOUT_COUNT
entry = {
    'iteration': $ITERATION, 'fixture': '$FIXTURE', 'result': '$result',
    'rejectReason': $rr_json,
    'baselineTotal': float('$CURRENT_BEST_TOTAL'),
    'baselineTestPassRate': float('$CURRENT_BEST_TEST_PASS_RATE'),
    'minImprovement': float('$MIN_IMPROVEMENT'),
    'agentExitCode': $agent_exit,
    'agentTimedOut': $([ "$agent_timed_out" = "true" ] && echo 'True' || echo 'False'),
    'startedAt': '$started_at', 'finishedAt': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
}
if $candid_total != None: entry['candidateTotal'] = $candid_total
if $candid_tpr != None: entry['candidateTestPassRate'] = $candid_tpr
if $verify_passed != None: entry['verifyPassed'] = $verify_passed
if $verify_exit != None: entry['verifyExitCode'] = $verify_exit
state['iterations'].append(entry)
json.dump(state, open('$LOOP_RUN_DIR/loop-state.json', 'w'), indent=2)
"
}

# ─── Helper: run_benchmark ──────────────────────────────────
run_benchmark() {
  local label="$1"
  local run_id="${label}-iter-${ITERATION}"
  echo "[loop] Running benchmark: $label ($run_id)" >&2
  bash "$BENCH_SCRIPT" "$run_id" "$LOOP_RUN_DIR" --timeout-seconds "$TIMEOUT_SECONDS" --synax-cmd "$SYNAX_CMD" --fixture "$FIXTURE" >&2
  local sf="$LOOP_RUN_DIR/$run_id/score.json"
  if [ -f "$sf" ]; then
    python3 -c "import json;s=json.load(open('$sf'));print(f\"{s.get('total',0)} {s.get('breakdown',{}).get('testPassRate',0)}\")" 2>/dev/null || echo "0 0"
  else
    echo "0 0"
  fi
}

# ─── Pre-loop checks ────────────────────────────────────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  if [ "$ALLOW_DIRTY" = true ]; then
    echo "[loop] WARNING: Repo dirty but --allow-dirty set."
  else
    echo "ERROR: Repo has uncommitted changes. Commit/stash or use --allow-dirty." >&2
    git status --short >&2; exit 1
  fi
fi

# ─── Header ─────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Synax Auto-Research Loop"
echo "  Max iterations:   $MAX_ITERATIONS"
echo "  Timeout:          ${TIMEOUT_SECONDS}s"
echo "  Artifacts:        $LOOP_RUN_DIR"
echo "  Fixture:          $FIXTURE"
echo "  Agent command:    $AGENT_CMD"
echo "  Dry run:          $DRY_RUN"
echo "  Patience:         $PATIENCE"
echo "  Min improvement:  $MIN_IMPROVEMENT"
[ -n "$MAX_WALL_MINUTES" ] && echo "  Max wall minutes: ${MAX_WALL_MINUTES}"
[ -n "$MAX_ACCEPTED" ]    && echo "  Max accepted:     ${MAX_ACCEPTED}"
[ -n "$MAX_REJECTED" ]    && echo "  Max rejected:     ${MAX_REJECTED}"
echo "  Cooldown:         ${COOLDOWN_SECONDS}s"
echo "  Stop file:        ${STOP_FILE}"
echo "  Allow dirty:      ${ALLOW_DIRTY}"
echo "  Allow harness:    ${ALLOW_HARNESS_EDITS}"
echo "  Initial HEAD:     $INITIAL_HEAD"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Step 0: Baseline ───────────────────────────────────────
echo "[loop] === Establishing baseline ==="
BASELINE_RESULT=$(run_benchmark "baseline")
BASELINE_TOTAL=$(echo "$BASELINE_RESULT" | cut -d' ' -f1)
BASELINE_TEST_PASS_RATE=$(echo "$BASELINE_RESULT" | cut -d' ' -f2)
CURRENT_BEST_TOTAL="$BASELINE_TOTAL"
CURRENT_BEST_TEST_PASS_RATE="$BASELINE_TEST_PASS_RATE"
echo "[loop] Baseline: total=$BASELINE_TOTAL testPassRate=$BASELINE_TEST_PASS_RATE"
BASELINE_RUN_DIR=$(ls -dt "$LOOP_RUN_DIR"/baseline-iter-* 2>/dev/null | head -1 || echo "")

cat > "$LOOP_RUN_DIR/loop-state.json" <<LOOPEOF
{
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "initialHead": "$INITIAL_HEAD", "fixture": "$FIXTURE",
  "baselineTotal": $BASELINE_TOTAL, "baselineTestPassRate": $BASELINE_TEST_PASS_RATE,
  "currentBestTotal": $CURRENT_BEST_TOTAL, "currentBestTestPassRate": $CURRENT_BEST_TEST_PASS_RATE,
  "acceptedCount": 0, "rejectedCount": 0, "noChangeCount": 0, "timeoutCount": 0,
  "lastCommit": null, "stopReason": null, "minImprovement": $MIN_IMPROVEMENT, "iterations": []
}
LOOPEOF

# ── Main loop ───────────────────────────────────────────────
while [ "$ITERATION" -lt "$MAX_ITERATIONS" ]; do
  ITERATION=$((ITERATION + 1)); ITER_START_EPOCH=$(date +%s)

  echo ""; echo "───────────────────────────────────────────────────────────────"
  echo "[loop] === Iteration $ITERATION / $MAX_ITERATIONS ==="
  echo "[loop] Best: total=$CURRENT_BEST_TOTAL tpr=$CURRENT_BEST_TEST_PASS_RATE"
  echo "[loop] Accepted:$ACCEPTED_COUNT Rejected:$REJECTED_COUNT No-change:$NO_CHANGE_COUNT Timeout:$TIMEOUT_COUNT"

  # Stop-file check
  if check_stop_file; then echo "[loop] Stop file detected: $STOP_FILE"; STOP_REASON="stop_file"; break; fi

  # Wall-clock check
  if [ -n "$MAX_WALL_MINUTES" ]; then
    WALL_ELAPSED=$(( ($(date +%s) - LOOP_START_EPOCH) / 60 ))
    if [ "$WALL_ELAPSED" -ge "$MAX_WALL_MINUTES" ]; then
      echo "[loop] Wall limit: ${WALL_ELAPSED}m >= ${MAX_WALL_MINUTES}m"; STOP_REASON="max_wall_minutes"; break
    fi
    echo "[loop] Wall: ${WALL_ELAPSED}m / ${MAX_WALL_MINUTES}m"
  fi

  # Max-accepted check
  if [ -n "$MAX_ACCEPTED" ] && [ "$ACCEPTED_COUNT" -ge "$MAX_ACCEPTED" ]; then
    echo "[loop] Max accepted: $ACCEPTED_COUNT >= $MAX_ACCEPTED"; STOP_REASON="max_accepted"; break
  fi

  # Max-rejected check
  if [ -n "$MAX_REJECTED" ] && [ "$REJECTED_COUNT" -ge "$MAX_REJECTED" ]; then
    echo "[loop] Max rejected: $REJECTED_COUNT >= $MAX_REJECTED"; STOP_REASON="max_rejected"; break
  fi

  # ── Step 1: Run agent ────────────────────────────────────
  ITER_DIR="$LOOP_RUN_DIR/iter-${ITERATION}"
  mkdir -p "$ITER_DIR"

  if [ "$DRY_RUN" = true ]; then
    echo "[loop] DRY RUN: skipping agent."; AGENT_EXIT=0; AGENT_TIMED_OUT=false
  else
    echo "[loop] Running improvement agent..."
    LATEST_BASELINE="$BASELINE_RUN_DIR"
    AGENT_FULL_CMD="$AGENT_CMD"
    AGENT_FULL_CMD="${AGENT_FULL_CMD//\{ARTIFACTS_DIR\}/$LOOP_RUN_DIR}"
    AGENT_FULL_CMD="${AGENT_FULL_CMD//\{LATEST_BASELINE\}/$LATEST_BASELINE}"
    AGENT_FULL_CMD="${AGENT_FULL_CMD//\{IMPROVEMENT_PROMPT\}/$IMPROVEMENT_PROMPT}"
    echo "[loop] Agent cmd: $AGENT_FULL_CMD"

    export AUTO_RESEARCH_FIXTURE="$FIXTURE"
    export AUTO_RESEARCH_ARTIFACTS_DIR="$LOOP_RUN_DIR"
    export AUTO_RESEARCH_BASELINE_RUN_DIR="$BASELINE_RUN_DIR"
    export AUTO_RESEARCH_ITERATION_DIR="$ITER_DIR"
    export AUTO_RESEARCH_BASELINE_TOTAL="$CURRENT_BEST_TOTAL"
    export AUTO_RESEARCH_BASELINE_TEST_PASS_RATE="$CURRENT_BEST_TEST_PASS_RATE"
    export AUTO_RESEARCH_MIN_IMPROVEMENT="$MIN_IMPROVEMENT"
    export AUTO_RESEARCH_ITERATION="$ITERATION"
    export AUTO_RESEARCH_CURRENT_HEAD="$(git rev-parse HEAD)"
    export AUTO_RESEARCH_REPO_ROOT="$REPO_ROOT"

    cd "$REPO_ROOT"
    AGENT_EXIT=0; AGENT_TIMED_OUT=false
    if eval "$AGENT_FULL_CMD"; then AGENT_EXIT=0; else
      AGENT_EXIT=$?
      if [ "$AGENT_EXIT" -eq 124 ] || [ "$AGENT_EXIT" -eq 142 ]; then
        AGENT_TIMED_OUT=true; TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
      fi
      echo "[loop] Agent exited: $AGENT_EXIT"
    fi
  fi

  AGENT_DURATION=$(( $(date +%s) - ITER_START_EPOCH ))

  # ── Step 2: Check for changes ────────────────────────────
  cd "$REPO_ROOT"
  if git diff --quiet && git diff --cached --quiet; then
    echo "[loop] No changes detected. Skipping candidate benchmark."
    cat > "$ITER_DIR/result.json" <<EOF
{"iteration":$ITERATION,"fixture":"$FIXTURE","baselineTotal":$CURRENT_BEST_TOTAL,"candidateTotal":null,"baselineTestPassRate":$CURRENT_BEST_TEST_PASS_RATE,"candidateTestPassRate":null,"minImprovement":$MIN_IMPROVEMENT,"accepted":false,"rejectReason":"no_changes","forbiddenPathsChanged":[],"changedFiles":[],"commitSha":null,"agentExitCode":$AGENT_EXIT,"agentTimedOut":$AGENT_TIMED_OUT,"benchmarkExitCode":null,"verifyExitCode":null,"verifyPassed":null,"startedAt":"$(date -u -r "$ITER_START_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)","finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","durationSeconds":$AGENT_DURATION,"stopReason":null}
EOF
    STREAK_WITHOUT_IMPROVEMENT=$((STREAK_WITHOUT_IMPROVEMENT + 1))
    NO_CHANGE_COUNT=$((NO_CHANGE_COUNT + 1))
    update_loop_state "no_changes" "" "$AGENT_EXIT" "$AGENT_TIMED_OUT" "" "$ITER_START_EPOCH"
    if [ "$STREAK_WITHOUT_IMPROVEMENT" -ge "$PATIENCE" ]; then STOP_REASON="patience"; break; fi
    [ "$COOLDOWN_SECONDS" -gt 0 ] && sleep "$COOLDOWN_SECONDS"
    continue
  fi

  echo "[loop] Changes detected:"; git diff --stat 2>/dev/null || true
  CHANGED_FILES=$(git diff --name-only 2>/dev/null | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//' || echo "")

  # ── Step 2.5: Forbidden path check ───────────────────────
  if [ "$ALLOW_HARNESS_EDITS" = false ]; then
    FORBIDDEN_CHANGED=""
    if ! FORBIDDEN_CHANGED=$(check_forbidden_paths); then
      echo "[loop] ✗ FORBIDDEN: $FORBIDDEN_CHANGED"
      FORBIDDEN_JSON=$(echo "$FORBIDDEN_CHANGED" | sed 's/ */","/g' | sed 's/^/"/;s/$/"/')
      if [ "$DRY_RUN" = false ]; then
        echo "[loop] Restoring..."; git restore .; git checkout -- . 2>/dev/null || true
        cleanup_agent_untracked "$ITER_DIR"
      fi
      cat > "$ITER_DIR/result.json" <<EOF
{"iteration":$ITERATION,"fixture":"$FIXTURE","baselineTotal":$CURRENT_BEST_TOTAL,"candidateTotal":null,"baselineTestPassRate":$CURRENT_BEST_TEST_PASS_RATE,"candidateTestPassRate":null,"minImprovement":$MIN_IMPROVEMENT,"accepted":false,"rejectReason":"forbidden_paths_changed","forbiddenPathsChanged":[$FORBIDDEN_JSON],"changedFiles":[],"commitSha":null,"agentExitCode":$AGENT_EXIT,"agentTimedOut":$AGENT_TIMED_OUT,"benchmarkExitCode":null,"verifyExitCode":null,"verifyPassed":null,"startedAt":"$(date -u -r "$ITER_START_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)","finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","durationSeconds":$AGENT_DURATION,"stopReason":null}
EOF
      STREAK_WITHOUT_IMPROVEMENT=$((STREAK_WITHOUT_IMPROVEMENT + 1))
      REJECTED_COUNT=$((REJECTED_COUNT + 1))
      update_loop_state "forbidden_paths_changed" "forbidden_paths_changed" "$AGENT_EXIT" "$AGENT_TIMED_OUT" "" "$ITER_START_EPOCH"
      if [ "$STREAK_WITHOUT_IMPROVEMENT" -ge "$PATIENCE" ]; then STOP_REASON="patience"; break; fi
      [ "$COOLDOWN_SECONDS" -gt 0 ] && sleep "$COOLDOWN_SECONDS"
      continue
    fi
  fi

  # ── Step 2.6: Verify candidate patch (npm run verify) ───
  # Cheap deterministic gate: reject broken patches before
  # spending time on the expensive candidate benchmark.
  VERIFY_PASSED=null
  VERIFY_EXIT=null
  if [ "$DRY_RUN" = true ]; then
    echo "[loop] DRY RUN: skipping npm run verify."
    VERIFY_PASSED=true
    VERIFY_EXIT=0
  else
    echo "[loop] Running npm run verify..."
    VERIFY_OUT="$ITER_DIR/verify-output.txt"
    cd "$REPO_ROOT"
    VERIFY_EXIT=0
    npm run verify > "$VERIFY_OUT" 2>&1 || VERIFY_EXIT=$?
    if [ "$VERIFY_EXIT" -eq 0 ]; then
      echo "[loop] ✓ npm run verify passed."
      VERIFY_PASSED=true
    else
      echo "[loop] ✗ npm run verify FAILED (exit $VERIFY_EXIT)."
      echo "[loop] Verify output: $VERIFY_OUT"
      VERIFY_PASSED=false

      # Reject candidate — restore and record
      if [ "$DRY_RUN" = false ]; then
        echo "[loop] Restoring tracked files..."
        git restore .
        git checkout -- . 2>/dev/null || true
        cleanup_agent_untracked "$ITER_DIR"
      else
        echo "[loop] DRY RUN: would restore tracked files."
      fi

      cat > "$ITER_DIR/result.json" <<EOF
{"iteration":$ITERATION,"fixture":"$FIXTURE","baselineTotal":$CURRENT_BEST_TOTAL,"candidateTotal":null,"baselineTestPassRate":$CURRENT_BEST_TEST_PASS_RATE,"candidateTestPassRate":null,"minImprovement":$MIN_IMPROVEMENT,"accepted":false,"rejectReason":"verify_failed","forbiddenPathsChanged":[],"changedFiles":[$CHANGED_FILES],"commitSha":null,"agentExitCode":$AGENT_EXIT,"agentTimedOut":$AGENT_TIMED_OUT,"benchmarkExitCode":null,"verifyExitCode":$VERIFY_EXIT,"verifyPassed":false,"startedAt":"$(date -u -r "$ITER_START_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)","finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","durationSeconds":$(( $(date +%s) - ITER_START_EPOCH )),"stopReason":null}
EOF

      STREAK_WITHOUT_IMPROVEMENT=$((STREAK_WITHOUT_IMPROVEMENT + 1))
      REJECTED_COUNT=$((REJECTED_COUNT + 1))
      update_loop_state "verify_failed" "verify_failed" "$AGENT_EXIT" "$AGENT_TIMED_OUT" "" "$ITER_START_EPOCH" "False" "$VERIFY_EXIT"
      if [ "$STREAK_WITHOUT_IMPROVEMENT" -ge "$PATIENCE" ]; then STOP_REASON="patience"; break; fi
      [ "$COOLDOWN_SECONDS" -gt 0 ] && sleep "$COOLDOWN_SECONDS"
      continue
    fi
  fi

  # ── Step 3: Candidate benchmark ──────────────────────────
  echo "[loop] Running candidate benchmark..."
  CANDIDATE_RESULT=$(run_benchmark "iter" || echo "0 0")
  CANDIDATE_TOTAL=$(echo "$CANDIDATE_RESULT" | cut -d' ' -f1)
  CANDIDATE_TEST_PASS_RATE=$(echo "$CANDIDATE_RESULT" | cut -d' ' -f2)
  BENCH_EXIT=$?
  echo "[loop] Candidate: total=$CANDIDATE_TOTAL tpr=$CANDIDATE_TEST_PASS_RATE"
  echo "[loop] Baseline:  total=$CURRENT_BEST_TOTAL tpr=$CURRENT_BEST_TEST_PASS_RATE"

  # ── Step 4: Accept/Reject ────────────────────────────────
  ACCEPTED=$(python3 -c "
ct=float('$CANDIDATE_TOTAL' or '0'); ctp=float('$CANDIDATE_TEST_PASS_RATE' or '0')
bt=float('$CURRENT_BEST_TOTAL' or '0'); btp=float('$CURRENT_BEST_TEST_PASS_RATE' or '0')
mi=float('$MIN_IMPROVEMENT' or '0.05'); e=1e-9
print('true' if ct>=bt+mi-e and ctp>btp+e else 'false')
")

  REJECT_REASON_JSON=""; REJECT_REASON_LABEL=""
  if [ "$ACCEPTED" = "true" ]; then
    REJECT_REASON_JSON="null"; REJECT_REASON_LABEL="null"
  else
    TOK=$(python3 -c "ct=float('$CANDIDATE_TOTAL' or '0');bt=float('$CURRENT_BEST_TOTAL' or '0');mi=float('$MIN_IMPROVEMENT' or '0.05');print('true' if ct>=bt+mi-1e-9 else 'false')")
    TPK=$(python3 -c "ctp=float('$CANDIDATE_TEST_PASS_RATE' or '0');btp=float('$CURRENT_BEST_TEST_PASS_RATE' or '0');print('true' if ctp>btp+1e-9 else 'false')")
    if [ "$TOK" = "false" ] && [ "$TPK" = "false" ]; then
      REJECT_REASON_JSON='"score_not_improved"'; REJECT_REASON_LABEL="score_not_improved"
    elif [ "$TOK" = "false" ]; then
      REJECT_REASON_JSON='"total_insufficient_improvement"'; REJECT_REASON_LABEL="total_insufficient_improvement"
    else
      REJECT_REASON_JSON='"test_pass_rate_not_improved"'; REJECT_REASON_LABEL="test_pass_rate_not_improved"
    fi
  fi

  ITER_FINISHED_EPOCH=$(date +%s); ITER_DURATION=$((ITER_FINISHED_EPOCH - ITER_START_EPOCH))
  COMMIT_SHA_JSON="null"

  if [ "$ACCEPTED" = "true" ]; then
    echo "[loop] ✓ Accepted: $CURRENT_BEST_TOTAL → $CANDIDATE_TOTAL, tpr $CURRENT_BEST_TEST_PASS_RATE → $CANDIDATE_TEST_PASS_RATE"
    if [ "$DRY_RUN" = false ]; then
      git add -A
      git commit -m "auto-research [$FIXTURE]: total ${CURRENT_BEST_TOTAL} → ${CANDIDATE_TOTAL}, tpr ${CURRENT_BEST_TEST_PASS_RATE} → ${CANDIDATE_TEST_PASS_RATE} (iter ${ITERATION})" || true
      COMMIT_SHA_JSON="\"$(git rev-parse HEAD)\""
    fi
    CURRENT_BEST_TOTAL="$CANDIDATE_TOTAL"; CURRENT_BEST_TEST_PASS_RATE="$CANDIDATE_TEST_PASS_RATE"
    STREAK_WITHOUT_IMPROVEMENT=0; ACCEPTED_COUNT=$((ACCEPTED_COUNT + 1)); ITER_RESULT="accepted"
  else
    echo "[loop] ✗ Rejected: $REJECT_REASON_LABEL ($CURRENT_BEST_TOTAL → $CANDIDATE_TOTAL)"
    if [ "$DRY_RUN" = false ]; then
      git restore .; git checkout -- . 2>/dev/null || true
      cleanup_agent_untracked "$ITER_DIR"
    fi
    STREAK_WITHOUT_IMPROVEMENT=$((STREAK_WITHOUT_IMPROVEMENT + 1))
    REJECTED_COUNT=$((REJECTED_COUNT + 1)); ITER_RESULT="rejected"
  fi

  # ── Step 5: Record result ────────────────────────────────
  cat > "$ITER_DIR/result.json" <<EOF
{"iteration":$ITERATION,"fixture":"$FIXTURE","baselineTotal":$CURRENT_BEST_TOTAL,"candidateTotal":$CANDIDATE_TOTAL,"baselineTestPassRate":$CURRENT_BEST_TEST_PASS_RATE,"candidateTestPassRate":$CANDIDATE_TEST_PASS_RATE,"minImprovement":$MIN_IMPROVEMENT,"accepted":$ACCEPTED,"rejectReason":$REJECT_REASON_JSON,"forbiddenPathsChanged":[],"changedFiles":[$CHANGED_FILES],"commitSha":$COMMIT_SHA_JSON,"agentExitCode":$AGENT_EXIT,"agentTimedOut":$AGENT_TIMED_OUT,"benchmarkExitCode":$BENCH_EXIT,"verifyExitCode":$VERIFY_EXIT,"verifyPassed":$VERIFY_PASSED,"startedAt":"$(date -u -r "$ITER_START_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)","finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","durationSeconds":$ITER_DURATION,"stopReason":null}
EOF

  update_loop_state "$ITER_RESULT" "$REJECT_REASON_LABEL" "$AGENT_EXIT" "$AGENT_TIMED_OUT" "$COMMIT_SHA_JSON" "$ITER_START_EPOCH" "$CANDIDATE_TOTAL" "$CANDIDATE_TEST_PASS_RATE" $([ "$VERIFY_PASSED" = "true" ] && echo 'True' || echo 'False') "$VERIFY_EXIT"

  if [ "$STREAK_WITHOUT_IMPROVEMENT" -ge "$PATIENCE" ]; then
    echo "[loop] Patience exhausted."; STOP_REASON="patience"; break
  fi
  [ "$COOLDOWN_SECONDS" -gt 0 ] && { echo "[loop] Cooldown ${COOLDOWN_SECONDS}s..."; sleep "$COOLDOWN_SECONDS"; }
done

# ─── Final summary ──────────────────────────────────────────
LOOP_END_EPOCH=$(date +%s); LOOP_DURATION=$(( (LOOP_END_EPOCH - LOOP_START_EPOCH) / 60 ))
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Auto-Research Loop Complete"
echo "  Stop reason:      $STOP_REASON"
echo "  Fixture:          $FIXTURE"
echo "  Iterations:       $ITERATION / $MAX_ITERATIONS"
echo "  Duration:         ${LOOP_DURATION}m"
echo "  Baseline total:   $BASELINE_TOTAL"
echo "  Baseline tpr:     $BASELINE_TEST_PASS_RATE"
echo "  Final best total: $CURRENT_BEST_TOTAL"
echo "  Final best tpr:   $CURRENT_BEST_TEST_PASS_RATE"
echo "  Accepted: $ACCEPTED_COUNT | Rejected: $REJECTED_COUNT | No-chg: $NO_CHANGE_COUNT | Timeout: $TIMEOUT_COUNT"
echo "  Artifacts:        $LOOP_RUN_DIR"
echo "═══════════════════════════════════════════════════════════════"

cd "$REPO_ROOT"
LAST_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "$INITIAL_HEAD")
python3 <<PYFINAL
import json
state = json.load(open('$LOOP_RUN_DIR/loop-state.json'))
state['updatedAt'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
state['stopReason'] = '$STOP_REASON'
state['currentBestTotal'] = float('$CURRENT_BEST_TOTAL')
state['currentBestTestPassRate'] = float('$CURRENT_BEST_TEST_PASS_RATE')
state['acceptedCount'] = $ACCEPTED_COUNT
state['rejectedCount'] = $REJECTED_COUNT
state['noChangeCount'] = $NO_CHANGE_COUNT
state['timeoutCount'] = $TIMEOUT_COUNT
state['lastCommit'] = '$LAST_COMMIT'
json.dump(state, open('$LOOP_RUN_DIR/loop-state.json', 'w'), indent=2)
PYFINAL

cd "$REPO_ROOT"
if [ "$DRY_RUN" = false ]; then
  CURRENT_HEAD=$(git rev-parse HEAD)
  if [ "$CURRENT_HEAD" != "$INITIAL_HEAD" ]; then
    echo "[loop] HEAD: $INITIAL_HEAD → $CURRENT_HEAD (improvements committed)."
    echo "[loop] Restore: git checkout $INITIAL_HEAD"
  fi
else
  echo "[loop] Dry run complete — no source changes made."
fi
