#!/bin/sh
# quotes.sh — Test quoted argument parsing.
#
# Both single-quoted and double-quoted strings containing spaces
# must be preserved as single arguments. The literal quote characters
# must NOT appear in the output (the shell strips them).

set -e

SHELL="${SHELL_BIN:-../mini-shell}"

# Double-quoted argument: output must contain "hello world" but no " char.
output=$(printf '/bin/echo "hello world"\nexit\n' | "$SHELL")
echo "$output" | grep -q "hello world" || exit 1
if echo "$output" | grep -q '"'; then exit 1; fi

# Single-quoted argument: output must contain "foo bar" but no ' char.
output=$(printf "/bin/echo 'foo bar'\nexit\n" | "$SHELL")
echo "$output" | grep -q "foo bar" || exit 1
if echo "$output" | grep -q "'"; then exit 1; fi
