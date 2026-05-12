#!/usr/bin/env bash
# verify-pack.sh — smoke-test the Synax npm package tarball
#
# Runs `npm pack`, installs the resulting tarball in a temp project,
# and checks that the CLI binary works and that the package contents
# are correct (no leaked test/config files, dist/ present).
#
# Exit 0 on pass, non-zero on failure.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS=0
FAIL=0

pass() {
  echo -e "  ${GREEN}✓${NC} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "  ${RED}✗${NC} $1"
  FAIL=$((FAIL + 1))
}

info() {
  echo -e "  ${YELLOW}→${NC} $1"
}

cleanup() {
  if [ -n "${TMPDIR:-}" ] && [ -d "$TMPDIR" ]; then
    info "Cleaning up temp directory: $TMPDIR"
    rm -rf "$TMPDIR"
  fi
  # Clean up tarball left in project root
  if [ -n "${CWD:-}" ]; then
    rm -f "$CWD"/synax-*.tgz
  fi
}

trap cleanup EXIT

echo ""
echo "============================================"
echo "  Synax Package Verification"
echo "============================================"
echo ""

CWD="$(pwd)"

# ---- 1. Build check ----
info "Checking clean build exists..."
if [ ! -f "$CWD/dist/cli.js" ]; then
  fail "dist/cli.js not found — run 'npm run build' first"
  exit 1
fi
pass "dist/cli.js found"

# ---- 2. npm pack ----
info "Running npm pack..."
# `npm pack` prints the tarball filename as the last line (after npm notice lines).
# We capture all output and parse the filename from the final non-empty line.
PACK_OUTPUT=$(npm pack 2>&1)
TARBALL_FILE=$(echo "$PACK_OUTPUT" | tail -1)
if [ ! -f "$TARBALL_FILE" ]; then
  fail "npm pack did not produce a tarball (got: '$TARBALL_FILE')"
  exit 1
fi
pass "npm pack produced $TARBALL_FILE"

# ---- 3. Install in temp project ----
# Use a subdirectory of the project dir to avoid macOS TMPDIR SIP issues.
TMPDIR="$CWD/.tmp-pack-verify-$$"
mkdir -p "$TMPDIR"
info "Temp directory: $TMPDIR"

# Initialize a minimal package.json so npm install doesn't walk up the tree
echo '{"private": true}' > "$TMPDIR/package.json"
info "Installing tarball..."
if npm install --prefix "$TMPDIR" "$CWD/$TARBALL_FILE" > /dev/null 2>&1; then
  pass "npm install of tarball succeeded"
else
  fail "npm install of tarball failed"
fi

BIN="$TMPDIR/node_modules/.bin/synax"
if [ ! -f "$BIN" ]; then
  fail "CLI binary not found at node_modules/.bin/synax"
else
  pass "CLI binary installed"
fi

# ---- 4. CLI smoke tests ----
info "Testing CLI commands..."

run_cli() {
  local desc="$1"
  shift
  if "$BIN" "$@" --help > /dev/null 2>&1; then
    pass "synax $desc"
  else
    fail "synax $desc (exit code: $?)"
  fi
}

run_cli "--help"
run_cli "inspect --help" inspect
run_cli "run --help" run
run_cli "doctor --help" doctor

# ---- 5. Verify package contents ----
PKG_DIR="$TMPDIR/node_modules/synax"
info "Verifying package contents..."

# dist/ directory present (as a directory, not just a file)
if [ -d "$PKG_DIR/dist" ]; then
  pass "dist/ directory present"
else
  fail "dist/ directory missing"
fi

# No test files
TEST_FILES=$(find "$PKG_DIR" -type f \( -name "*.test.js" -o -path "*/__tests__/*" \) 2>/dev/null || true)
if [ -z "$TEST_FILES" ]; then
  pass "No test files (*.test.js, __tests__) in package"
else
  fail "Test files found in package:"
  echo "$TEST_FILES" | while read -r f; do echo "    $f"; done
fi

# No leaked config/temp files
LEAKED=()
PATTERNS=(".synax.toml" ".synax/" "AGENTS.md" "src/" "specs/" "scripts/")
for pattern in "${PATTERNS[@]}"; do
  if [ -e "$PKG_DIR/$pattern" ]; then
    LEAKED+=("$pattern")
  fi
done
if [ ${#LEAKED[@]} -eq 0 ]; then
  pass "No config/temp files (.synax.toml, .synax/, AGENTS.md, src/, specs/, scripts/) in package"
else
  for leaked in "${LEAKED[@]}"; do
    fail "Leaked file/dir in package: $leaked"
  done
fi

# ---- 6. Summary ----
echo ""
echo "============================================"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo -e "  ${GREEN}ALL $PASS CHECKS PASSED${NC}"
  echo "============================================"
  echo ""
  exit 0
else
  echo -e "  ${RED}$FAIL OF $TOTAL CHECKS FAILED${NC}"
  echo "============================================"
  echo ""
  exit 1
fi
