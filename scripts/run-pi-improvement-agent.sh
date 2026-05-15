#!/usr/bin/env bash
# run-pi-improvement-agent.sh — Invoke Pi (DeepSeek) as the improvement agent.
#
# Reads benchmark artifacts, identifies one product-level issue, applies exactly
# one minimal patch to Synax source, runs verification, writes a report, exits.
#
# Usage:
#   scripts/run-pi-improvement-agent.sh
#
# Required environment variables (exported by auto-research-loop.sh):
#   AUTO_RESEARCH_FIXTURE              Fixture name (e.g. mini-shell)
#   AUTO_RESEARCH_ARTIFACTS_DIR        Path to loop artifacts directory
#   AUTO_RESEARCH_BASELINE_RUN_DIR     Path to the most recent baseline run dir
#   AUTO_RESEARCH_ITERATION_DIR        Path to this iteration's artifact dir
#   AUTO_RESEARCH_BASELINE_TOTAL       Baseline total score
#   AUTO_RESEARCH_BASELINE_TEST_PASS_RATE  Baseline test pass rate
#   AUTO_RESEARCH_MIN_IMPROVEMENT      Min improvement threshold
#
# Optional environment variables:
#   PI_AUTO_RESEARCH_PROVIDER         Provider (default: deepseek)
#   PI_AUTO_RESEARCH_MODEL            Model (default: deepseek-v4-pro:high)
#   PI_AUTO_RESEARCH_TOOLS            Tool allowlist (default: read,bash,edit,write,grep,find,ls)
#   PI_AUTO_RESEARCH_TIMEOUT_SECONDS  Timeout seconds (default: 900)
#   PI_AUTO_RESEARCH_EXTRA_ARGS       Extra args passed to pi
#   AUTO_RESEARCH_ITERATION           Current iteration number
#   AUTO_RESEARCH_CURRENT_HEAD        Current git HEAD
#   AUTO_RESEARCH_REPO_ROOT           Repository root path

set -euo pipefail

# ─── Resolve repo root ───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${AUTO_RESEARCH_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# ─── Validate required env vars ──────────────────────────────
missing_vars=()
for var in AUTO_RESEARCH_FIXTURE AUTO_RESEARCH_ARTIFACTS_DIR \
           AUTO_RESEARCH_BASELINE_RUN_DIR AUTO_RESEARCH_ITERATION_DIR \
           AUTO_RESEARCH_BASELINE_TOTAL AUTO_RESEARCH_BASELINE_TEST_PASS_RATE \
           AUTO_RESEARCH_MIN_IMPROVEMENT; do
  if [ -z "${!var:-}" ]; then
    missing_vars+=("$var")
  fi
done

if [ ${#missing_vars[@]} -gt 0 ]; then
  echo "ERROR: Missing required environment variables: ${missing_vars[*]}" >&2
  echo "These are normally exported by auto-research-loop.sh." >&2
  exit 1
fi

# ─── Defaults for optional vars ──────────────────────────────
PI_PROVIDER="${PI_AUTO_RESEARCH_PROVIDER:-deepseek}"
PI_MODEL="${PI_AUTO_RESEARCH_MODEL:-deepseek-v4-pro:high}"
PI_TOOLS="${PI_AUTO_RESEARCH_TOOLS:-read,bash,edit,write,grep,find,ls}"
PI_TIMEOUT="${PI_AUTO_RESEARCH_TIMEOUT_SECONDS:-900}"
PI_EXTRA_ARGS="${PI_AUTO_RESEARCH_EXTRA_ARGS:-}"
ITERATION="${AUTO_RESEARCH_ITERATION:-?}"

# ─── Check pi is available ───────────────────────────────────
if ! command -v pi &>/dev/null; then
  echo "ERROR: 'pi' command not found in PATH." >&2
  echo "Install pi: npm install -g @earendil-works/pi-coding-agent" >&2
  exit 1
fi

# ─── Check timeout wrapper ───────────────────────────────────
TIMEOUT_WRAPPER="$REPO_ROOT/scripts/with-timeout.sh"
if [ ! -f "$TIMEOUT_WRAPPER" ]; then
  echo "ERROR: timeout wrapper not found: $TIMEOUT_WRAPPER" >&2
  exit 1
fi

# ─── Resolve artifact paths ──────────────────────────────────
BASE_DIR="$AUTO_RESEARCH_BASELINE_RUN_DIR"
ITER_DIR="$AUTO_RESEARCH_ITERATION_DIR"
ARTIFACTS_DIR="$AUTO_RESEARCH_ARTIFACTS_DIR"

mkdir -p "$ITER_DIR"

# ─── Build agent prompt ───────────────────────────────────────
BASE_PROMPT_FILE="$REPO_ROOT/benchmarks/synax-auto-research/improvement-agent-prompt.md"
if [ ! -f "$BASE_PROMPT_FILE" ]; then
  echo "ERROR: base prompt not found: $BASE_PROMPT_FILE" >&2
  exit 1
fi

# Create a temporary prompt file with loop context prepended.
# We write this to ITER_DIR so it is preserved as an artifact.
AGENT_PROMPT_FILE="$ITER_DIR/pi-agent-prompt.md"

cat > "$AGENT_PROMPT_FILE" <<'PROMPT_HEADER'
# Auto-Research Improvement Agent — Loop Context

You are Pi, powered by DeepSeek. You are the **improvement agent** in the
Synax auto-research loop.

**Synax** (running Gemma via Relay) is the **benchmark subject**.
You are NOT Synax. You are Pi. You should NOT use Synax to modify itself.

## Loop State

PROMPT_HEADER

# Append the dynamic context
cat >> "$AGENT_PROMPT_FILE" <<PROMPT_CONTEXT
- Fixture: ${AUTO_RESEARCH_FIXTURE}
- Iteration: ${ITERATION}
- Baseline total score: ${AUTO_RESEARCH_BASELINE_TOTAL}
- Baseline test pass rate: ${AUTO_RESEARCH_BASELINE_TEST_PASS_RATE}
- Min improvement threshold: ${AUTO_RESEARCH_MIN_IMPROVEMENT}
- Repo root: ${REPO_ROOT}
- Current HEAD: ${AUTO_RESEARCH_CURRENT_HEAD:-unknown}

## Artifact Paths

The following baseline artifacts are available for inspection:

- Score:        \`${BASE_DIR}/score.json\`
- Transcript:   \`${BASE_DIR}/transcript.txt\`
- Test output:  \`${BASE_DIR}/test-output.txt\`
- Git diff:     \`${BASE_DIR}/git-diff.txt\`
- Meta:         \`${BASE_DIR}/meta.json\`
- Prompt:       \`${BASE_DIR}/prompt.txt\`
PROMPT_CONTEXT

# Conditionally include optional artifacts
if [ -f "$BASE_DIR/synax-config-sanitized.toml" ]; then
  echo "- Sanitized config: \`${BASE_DIR}/synax-config-sanitized.toml\`" >> "$AGENT_PROMPT_FILE"
fi

cat >> "$AGENT_PROMPT_FILE" <<PROMPT_MIDDLE

## Output

Write your agent report to:
\`${ITER_DIR}/agent-report.md\`

---

PROMPT_MIDDLE

# Append the base improvement prompt
cat "$BASE_PROMPT_FILE" >> "$AGENT_PROMPT_FILE"

echo "[pi-agent] Prompt written to: $AGENT_PROMPT_FILE"

# ─── Build pi command ────────────────────────────────────────
PI_CMD=(
  pi
  -p
  --no-session
  --provider "$PI_PROVIDER"
  --model "$PI_MODEL"
  --tools "$PI_TOOLS"
)

# Add extra args if provided
if [ -n "$PI_EXTRA_ARGS" ]; then
  # Word-split extra args carefully
  IFS=' ' read -ra EXTRA <<< "$PI_EXTRA_ARGS"
  PI_CMD+=("${EXTRA[@]}")
fi

# Pass the prompt file as the message
PI_CMD+=("@$AGENT_PROMPT_FILE")

echo "[pi-agent] Provider:  $PI_PROVIDER"
echo "[pi-agent] Model:     $PI_MODEL"
echo "[pi-agent] Tools:     $PI_TOOLS"
echo "[pi-agent] Timeout:   ${PI_TIMEOUT}s"
echo "[pi-agent] Iteration: $ITERATION"
echo "[pi-agent] Running from: $REPO_ROOT"

# ─── Run pi with timeout ─────────────────────────────────────
PI_OUTPUT_FILE="$ITER_DIR/pi-agent-output.txt"
START_EPOCH=$(date +%s)
PI_EXIT=0

cd "$REPO_ROOT"

bash "$TIMEOUT_WRAPPER" "$PI_TIMEOUT" "${PI_CMD[@]}" \
  > "$PI_OUTPUT_FILE" 2>&1 || PI_EXIT=$?

END_EPOCH=$(date +%s)
PI_DURATION=$((END_EPOCH - START_EPOCH))

# ─── Determine timeout status ─────────────────────────────────
TIMED_OUT=false
if [ "$PI_EXIT" -eq 124 ]; then
  TIMED_OUT=true
  echo "[pi-agent] TIMED OUT after ${PI_DURATION}s (limit: ${PI_TIMEOUT}s)" | tee -a "$PI_OUTPUT_FILE"
elif [ "$PI_EXIT" -ne 0 ]; then
  echo "[pi-agent] Exited with code $PI_EXIT after ${PI_DURATION}s" | tee -a "$PI_OUTPUT_FILE"
else
  echo "[pi-agent] Completed successfully in ${PI_DURATION}s" | tee -a "$PI_OUTPUT_FILE"
fi

# ─── Write agent result metadata ──────────────────────────────
cat > "$ITER_DIR/agent-result.json" <<METAEOF
{
  "agent": "pi",
  "provider": "$PI_PROVIDER",
  "model": "$PI_MODEL",
  "tools": "$PI_TOOLS",
  "timeoutSeconds": $PI_TIMEOUT,
  "exitCode": $PI_EXIT,
  "timedOut": $TIMED_OUT,
  "durationSeconds": $PI_DURATION,
  "startedAt": "$(date -u -r "$START_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)",
  "promptFile": "$AGENT_PROMPT_FILE",
  "outputFile": "$PI_OUTPUT_FILE"
}
METAEOF

echo "[pi-agent] Agent metadata written to: $ITER_DIR/agent-result.json"

# ─── Report whether agent-report.md was created ───────────────
if [ -f "$ITER_DIR/agent-report.md" ]; then
  echo "[pi-agent] Agent report found: $ITER_DIR/agent-report.md"
else
  echo "[pi-agent] No agent report found (Pi may not have written one)."
fi

# Exit with Pi's exit code so the loop can detect failures
exit $PI_EXIT
