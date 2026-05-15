#!/bin/sh
# redirection.sh — Test output redirection with > and >>.
#
# >  creates or truncates a file.
# >> appends to a file.

set -e

SHELL="${SHELL_BIN:-../mini-shell}"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

tell_shell() {
  printf "%s\nexit\n" "$1" | "$SHELL"
}

# Test >
tell_shell "/bin/echo hello > $TMPDIR/out.txt"
grep -q "hello" "$TMPDIR/out.txt"

# Test >> — file should contain both lines
tell_shell "/bin/echo world >> $TMPDIR/out.txt"
grep -q "hello" "$TMPDIR/out.txt"
grep -q "world" "$TMPDIR/out.txt"
