#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/homebrew-tap-identity.sh"

fail() {
  echo "test-homebrew-tap-identity.sh: $*" >&2
  exit 1
}

expect_identity_rejection() {
  local label="$1" repository="$2" tap_name="${3:-}"
  if homebrew_resolve_tap_name "$repository" "$tap_name" >/dev/null 2>&1; then
    fail "accepted $label"
  fi
}

[ "$(homebrew_resolve_tap_name kandelo-dev/homebrew-tap-core '')" = \
  "kandelo-dev/tap-core" ] || fail "protected default identity changed"
[ "$(homebrew_resolve_tap_name Acme/homebrew-tools Acme/tools)" = \
  "acme/tools" ] || fail "conventional third-party identity was not normalized"
[ "$(homebrew_bottle_root_url kandelo-dev/homebrew-tap-core '')" = \
  "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core" ] || fail "protected repository-rooted bottle namespace changed"
[ "$(homebrew_bottle_root_url Acme/homebrew-tools Acme/tools)" = \
  "https://ghcr.io/v2/acme/homebrew-tools" ] || fail "third-party bottle root was not derived from its repository"

expect_identity_rejection "an implicit third-party tap name" Acme/homebrew-tools
expect_identity_rejection "a nonconventional third-party repository" Acme/tools Acme/tools
expect_identity_rejection "a mismatched third-party tap name" Acme/homebrew-tools Acme/other
expect_identity_rejection "a mismatched default tap name" \
  kandelo-dev/homebrew-tap-core kandelo-dev/homebrew-tap-core

# These identity-only `hello` values are synthetic input. They do not resolve a
# tap Formula, read GHCR, or describe a package retained by the active tap.
provenance="$TMPDIR/dependency-provenance.json"
jq -nS '{
  schema: 2,
  formula: "hello",
  arch: "wasm32",
  tap_repository: "Acme/homebrew-tools",
  tap_name: "acme/tools",
  tap_commit: ("a" * 40),
  bottle_root_url: "https://ghcr.io/v2/acme/homebrew-tools",
  bottle_tag: "wasm32_kandelo",
  dependencies: []
}' >"$provenance"

python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
  --input "$provenance" \
  --formula hello \
  --arch wasm32 \
  --tap-repository Acme/homebrew-tools \
  --tap-name Acme/tools \
  --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --bottle-root-url https://ghcr.io/v2/acme/homebrew-tools

if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
  --input "$provenance" \
  --formula hello \
  --arch wasm32 \
  --tap-repository Acme/homebrew-tools \
  --tap-name Acme/other \
  --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --bottle-root-url https://ghcr.io/v2/acme/homebrew-tools >/dev/null 2>&1; then
  fail "dependency provenance accepted a mismatched repository and tap name"
fi

default_provenance="$TMPDIR/default-dependency-provenance.json"
jq -nS '{
  schema: 2,
  formula: "hello",
  arch: "wasm32",
  tap_repository: "kandelo-dev/homebrew-tap-core",
  tap_name: "kandelo-dev/tap-core",
  tap_commit: ("a" * 40),
  bottle_root_url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
  bottle_tag: "wasm32_kandelo",
  dependencies: []
}' >"$default_provenance"
python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
  --input "$default_provenance" \
  --formula hello \
  --arch wasm32 \
  --tap-repository kandelo-dev/homebrew-tap-core \
  --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core

if python3 "$REPO_ROOT/scripts/homebrew-oci-layout.py" source-closure \
  --tap-root "$REPO_ROOT" \
  --kandelo-root "$REPO_ROOT" \
  --tap-repository Acme/homebrew-tools \
  --tap-name Acme/other \
  --formula hello \
  --out "$TMPDIR/source-closure.json" >/dev/null 2>&1; then
  fail "OCI source closure accepted a mismatched repository and tap name"
fi

python3 "$REPO_ROOT/scripts/homebrew-oci-layout.py" source-closure \
  --tap-root "$REPO_ROOT/homebrew/homebrew-tap-core" \
  --kandelo-root "$REPO_ROOT" \
  --tap-repository kandelo-dev/homebrew-tap-core \
  --formula what \
  --out "$TMPDIR/default-source-closure.json"

echo "test-homebrew-tap-identity.sh: ok"
