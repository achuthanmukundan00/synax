#!/bin/sh
# run-tests.sh — Test harness for the mini-shell fixture.
#
# Runs each test case script in cases/ and reports a scorer-compatible summary:
#   N passed, M failed, T total
#
# Usage:  cd test && sh run-tests.sh

set -u

cd "$(dirname "$0")" || exit 1

PASSED=0
FAILED=0
TOTAL=0

run_test() {
  name="$1"
  script="$2"
  TOTAL=$((TOTAL + 1))
  if sh "$script" > /dev/null 2>&1; then
    PASSED=$((PASSED + 1))
    echo "PASS: $name"
  else
    FAILED=$((FAILED + 1))
    echo "FAIL: $name"
  fi
}

# Basic sanity: shell binary must exist and be executable
SHELL_BIN="$(dirname "$0")/../mini-shell"
if [ ! -x "$SHELL_BIN" ]; then
  echo "FAIL: shell binary not found at $SHELL_BIN"
  echo "0 passed, 1 failed, 1 total"
  exit 1
fi
export SHELL_BIN

run_test "simple-command"  cases/simple-command.sh
run_test "builtins"        cases/builtins.sh
run_test "quotes"          cases/quotes.sh
run_test "env-expansion"   cases/env-expansion.sh
run_test "redirection"     cases/redirection.sh
run_test "pipeline"        cases/pipeline.sh
run_test "exit-status"     cases/exit-status.sh

echo "$PASSED passed, $FAILED failed, $TOTAL total"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
