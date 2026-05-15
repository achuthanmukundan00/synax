#!/usr/bin/env bash
# with-timeout.sh — Run a command with a wall-clock timeout.
#
# Tries (in order):
#   1. gtimeout (macOS coreutils)
#   2. timeout  (GNU coreutils, Linux)
#   3. perl alarm (macOS built-in)
#
# Usage:
#   scripts/with-timeout.sh <seconds> <command...>
#
# Environment:
#   WITH_TIMEOUT_VERBOSE=1   Log timeout mechanism to stderr.
#
# Exit codes:
#   124  Command timed out
#   N    Command exited with code N
#   125  No timeout mechanism available

set -euo pipefail

TIMEOUT_SECS="${1:?Usage: $0 <seconds> <command...>}"
shift

if [ "${WITH_TIMEOUT_VERBOSE:-}" = "1" ]; then
  echo "[with-timeout] Timeout: ${TIMEOUT_SECS}s, command: $*" >&2
fi

# ── Try gtimeout (Homebrew coreutils on macOS) ──────────
if command -v gtimeout &>/dev/null; then
  if [ "${WITH_TIMEOUT_VERBOSE:-}" = "1" ]; then
    echo "[with-timeout] Using gtimeout" >&2
  fi
  exec gtimeout "$TIMEOUT_SECS" "$@"
fi

# ── Try timeout (GNU coreutils on Linux) ────────────────
if command -v timeout &>/dev/null; then
  # Some systems have a `timeout` that isn't GNU — only use it if it
  # supports the POSIX-like signature.
  if timeout --help 2>&1 | grep -q 'GNU\|coreutils\|--preserve-status'; then
    if [ "${WITH_TIMEOUT_VERBOSE:-}" = "1" ]; then
      echo "[with-timeout] Using timeout" >&2
    fi
    exec timeout "$TIMEOUT_SECS" "$@"
  fi
fi

# ── Fallback: perl alarm (works on macOS) ───────────────
if command -v perl &>/dev/null; then
  if [ "${WITH_TIMEOUT_VERBOSE:-}" = "1" ]; then
    echo "[with-timeout] Using perl alarm" >&2
  fi
  exec perl -e '
    $SIG{ALRM} = sub {
      print STDERR "[with-timeout] Command timed out after '"$TIMEOUT_SECS"' seconds\n";
      exit 124;
    };
    alarm shift;
    exec @ARGV
  ' "$TIMEOUT_SECS" "$@"
fi

# ── No timeout mechanism ────────────────────────────────
echo "[with-timeout] ERROR: no timeout mechanism found." >&2
echo "[with-timeout] Install coreutils (brew install coreutils) for macOS, or ensure perl is available." >&2
exit 125
