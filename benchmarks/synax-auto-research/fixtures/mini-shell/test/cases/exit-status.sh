#!/bin/sh
# exit-status.sh — Test exit builtin status codes.
#
# exit N must cause the shell to exit with status N.
# We cannot rely on set -e because a non-zero pipeline exit would
# terminate the script before we can inspect the status.

SHELL="${SHELL_BIN:-../mini-shell}"

# exit 0
echo "exit 0" | "$SHELL" > /dev/null 2>&1
ret=$?
if [ "$ret" -ne 0 ]; then exit 1; fi

# exit 42 — temporarily disable set -e for this pipeline
set +e
echo "exit 42" | "$SHELL" > /dev/null 2>&1
ret=$?
set -e
if [ "$ret" -ne 42 ]; then exit 1; fi
