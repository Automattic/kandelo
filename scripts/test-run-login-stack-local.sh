#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$REPO_ROOT/scripts/run-login-stack-local.sh"

fail() {
  echo "test-run-login-stack-local: $*" >&2
  exit 1
}

grep -Fq \
  '/usr/bin/sudo -n -- /usr/bin/chown root:root "$KANDELO_LOGIN_XTASK_BIN"' \
  "$HARNESS" ||
  fail "local login harness does not transfer the sealed checker to root"
grep -Fq '[ "$KANDELO_LOGIN_XTASK_UID" = 0 ]' "$HARNESS" ||
  fail "local login harness does not require root checker ownership"
grep -Fq \
  '"$(stat -c '\''%a:%h:%u'\'' "$KANDELO_LOGIN_XTASK_BIN")" = "555:1:0"' \
  "$HARNESS" ||
  fail "local login harness does not require one root-owned read-only inode"

reseal_body="$(
  sed -n \
    '/^reseal_formula_test_checker() {$/,/^}$/p' \
    "$HARNESS"
)"
[ -n "$reseal_body" ] ||
  fail "local login harness lacks its between-Formula checker reseal"
grep -Fq 'fail "Formula test checker bytes changed during $context"' \
  <<<"$reseal_body" ||
  fail "between-Formula reseal does not reject changed checker bytes"
grep -Fq '/usr/bin/sudo -n -- bash \' <<<"$reseal_body" ||
  fail "between-Formula checker reseal does not use root authority"
grep -Fq \
  '"$KANDELO_LOGIN_SOURCE/scripts/seal-homebrew-formula-checker.sh"' \
  <<<"$reseal_body" ||
  fail "between-Formula checker reseal does not use the reviewed sealer"
grep -Fq 'reseal_formula_test_checker "$formula sidecar generation"' \
  "$HARNESS" ||
  fail "local login harness does not reseal checker identity between Formulae"

echo "test-run-login-stack-local.sh: ok"
