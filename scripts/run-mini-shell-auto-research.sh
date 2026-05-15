#!/usr/bin/env bash
# run-mini-shell-auto-research.sh — Convenience launcher for the Synax auto-research loop.
#
# Runs the long-loop with Pi+DeepSeek improving Synax, benchmarked against Gemma
# on the mini-shell fixture. Tuned for unattended multi-hour runs.
#
# Usage:
#   bash scripts/run-mini-shell-auto-research.sh
#
# To stop:
#   touch .auto-research-stop
#
# Environment:
#   ALLOW_DIRTY=1            Allow running on a dirty repo (DANGEROUS)
#   MAX_ITERATIONS           Override max iterations (default: 20)
#   MAX_WALL_MINUTES         Override max wall minutes (default: 240)
#   MIN_IMPROVEMENT          Override min improvement threshold (default: 0.05)
#   PATIENCE                 Override patience (default: 5)
#   COOLDOWN_SECONDS         Override cooldown between iterations (default: 10)
#   ARTIFACTS_DIR            Override artifacts directory (default: ./benchmark-artifacts)
#   PI_AUTO_RESEARCH_PROVIDER       Pi provider (default: deepseek)
#   PI_AUTO_RESEARCH_MODEL          Pi model (default: deepseek-v4-pro:high)
#   PI_AUTO_RESEARCH_TIMEOUT_SECONDS Pi timeout (default: 900)
#   SYNAX_BENCH_THINKING     Benchmark thinking level (default: off)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Defaults ────────────────────────────────────────────────
MAX_ITER="${MAX_ITERATIONS:-20}"
MAX_WALL="${MAX_WALL_MINUTES:-240}"
MIN_IMP="${MIN_IMPROVEMENT:-0.05}"
PATIENCE_VAL="${PATIENCE:-5}"
COOLDOWN="${COOLDOWN_SECONDS:-10}"
ARTIFACTS="${ARTIFACTS_DIR:-./benchmark-artifacts}"
BENCH_THINKING="${SYNAX_BENCH_THINKING:-off}"

PI_PROVIDER="${PI_AUTO_RESEARCH_PROVIDER:-deepseek}"
PI_MODEL="${PI_AUTO_RESEARCH_MODEL:-deepseek-v4-pro:high}"
PI_TIMEOUT="${PI_AUTO_RESEARCH_TIMEOUT_SECONDS:-900}"

# ─── Pre-flight checks ───────────────────────────────────────
cd "$REPO_ROOT"

echo "═══════════════════════════════════════════════════════════════"
echo "  Synax Auto-Research — mini-shell long loop"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Benchmark subject:  Synax + Gemma (thinking=${BENCH_THINKING})"
echo "  Improvement agent:  Pi + DeepSeek"
echo "  Fixture:            mini-shell"
echo ""
echo "  Max iterations:     ${MAX_ITER}"
echo "  Max wall minutes:   ${MAX_WALL}"
echo "  Min improvement:    ${MIN_IMP}"
echo "  Patience:           ${PATIENCE_VAL}"
echo "  Cooldown:           ${COOLDOWN}s"
echo "  Pi timeout:         ${PI_TIMEOUT}s"
echo "  Pi provider:        ${PI_PROVIDER}"
echo "  Pi model:           ${PI_MODEL}"
echo "  Artifacts dir:      ${ARTIFACTS}"
echo ""
echo "  Branch:             $(git branch --show-current)"
echo "  HEAD:               $(git rev-parse --short HEAD)"
echo ""

# ─── Check for dirty repo ────────────────────────────────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  if [ "${ALLOW_DIRTY:-0}" = "1" ]; then
    echo "  ⚠ WARNING: Repo is dirty but ALLOW_DIRTY=1 is set." >&2
    echo "     Uncommitted changes WILL be committed if the loop accepts patches!" >&2
  else
    echo "  ERROR: Repository has uncommitted changes." >&2
    echo "  Commit or stash changes before running the auto-research loop." >&2
    echo "  Or set ALLOW_DIRTY=1 to force (dangerous — uncommitted changes may be committed)." >&2
    git status --short >&2
    exit 1
  fi
fi

# ─── Check prereqs ───────────────────────────────────────────
if [ ! -f "$REPO_ROOT/dist/cli.js" ]; then
  echo "[setup] Building Synax..."
  bun run build
fi

if ! command -v pi &>/dev/null; then
  echo "ERROR: 'pi' command not found. Install it first:" >&2
  echo "  npm install -g @earendil-works/pi-coding-agent" >&2
  exit 1
fi

# ─── Show stop instructions ──────────────────────────────────
echo "  To stop the loop:"
echo "    touch $REPO_ROOT/.auto-research-stop"
echo "    or press Ctrl-C"
echo ""
echo "  Artifacts will be written to: ${ARTIFACTS}"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── Build the loop command ──────────────────────────────────
# Export config for the sub-shells
export PI_AUTO_RESEARCH_PROVIDER="$PI_PROVIDER"
export PI_AUTO_RESEARCH_MODEL="$PI_MODEL"
export PI_AUTO_RESEARCH_TIMEOUT_SECONDS="$PI_TIMEOUT"
export SYNAX_BENCH_THINKING="$BENCH_THINKING"

LOOP_ARGS=(
  --max-iterations "$MAX_ITER"
  --timeout-seconds 300
  --artifacts-dir "$ARTIFACTS"
  --agent-cmd "bash $REPO_ROOT/scripts/run-pi-improvement-agent.sh"
  --fixture mini-shell
  --patience "$PATIENCE_VAL"
  --min-improvement "$MIN_IMP"
  --cooldown-seconds "$COOLDOWN"
)

if [ -n "$MAX_WALL" ] && [ "$MAX_WALL" != "0" ]; then
  LOOP_ARGS+=(--max-wall-minutes "$MAX_WALL")
fi

echo "[setup] Starting auto-research loop..."
echo "[setup] Command: bash $REPO_ROOT/scripts/auto-research-loop.sh ${LOOP_ARGS[*]}"
echo ""

exec bash "$REPO_ROOT/scripts/auto-research-loop.sh" "${LOOP_ARGS[@]}"
