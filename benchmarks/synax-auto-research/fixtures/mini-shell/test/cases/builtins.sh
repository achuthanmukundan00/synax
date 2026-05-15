#!/bin/sh
# builtins.sh — Test cd and pwd builtins.
#
# cd must change the shell's working directory.
# pwd must print the current directory.

set -e

SHELL="${SHELL_BIN:-../mini-shell}"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# cd to tmpdir and verify pwd
printf "cd %s\npwd\nexit\n" "$TMPDIR" | "$SHELL" | grep -q "$TMPDIR"
