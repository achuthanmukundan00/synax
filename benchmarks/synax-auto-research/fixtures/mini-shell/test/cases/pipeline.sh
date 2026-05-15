#!/bin/sh
# pipeline.sh — Test pipeline support.
#
# Without pipeline support, the shell passes `|` as a literal argument,
# so `echo hello | tr ...` just echoes the pipe char.  With real pipeline
# support, the output goes through tr and becomes uppercased.

set -e

SHELL="${SHELL_BIN:-../mini-shell}"

# "echo hello | tr '[:lower:]' '[:upper:]'" should produce "HELLO" when
# pipes work, but "hello | ..." when they don't.
output=$(printf '/bin/echo hello | /usr/bin/tr "[:lower:]" "[:upper:]"\nexit\n' | "$SHELL" 2>/dev/null)
echo "$output" | grep -q "HELLO" || exit 1
