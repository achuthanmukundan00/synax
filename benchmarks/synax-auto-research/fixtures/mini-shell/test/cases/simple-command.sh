#!/bin/sh
# simple-command.sh — Test basic external command execution.
#
# Verifies that the shell can run /bin/echo with and without arguments.

set -e

SHELL="${SHELL_BIN:-../mini-shell}"

# Single argument
echo "/bin/echo hello" | "$SHELL" | grep -q "hello"

# Multiple arguments
echo "/bin/echo foo bar" | "$SHELL" | grep -q "foo bar"

# Command with no arguments
echo "/bin/echo" | "$SHELL" | grep -q "^$"
