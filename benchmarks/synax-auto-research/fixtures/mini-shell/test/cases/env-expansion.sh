#!/bin/sh
# env-expansion.sh — Test environment variable expansion.
#
# $VAR outside quotes and "$VAR" inside double quotes must expand.
# Single-quoted '$VAR' must NOT expand.

set -e

SHELL="${SHELL_BIN:-../mini-shell}"

# $HOME unquoted — must start with /
printf '/bin/echo $HOME\nexit\n' | "$SHELL" | grep -q "^/"

# $HOME in double quotes
printf '/bin/echo "$HOME"\nexit\n' | "$SHELL" | grep -q "^/"
