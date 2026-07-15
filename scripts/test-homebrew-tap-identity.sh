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

[ "$(homebrew_resolve_tap_name Automattic/kandelo-homebrew '')" = \
  "automattic/kandelo-homebrew" ] || fail "first-party default identity changed"
[ "$(homebrew_resolve_tap_name Acme/homebrew-tools Acme/tools)" = \
  "acme/tools" ] || fail "conventional third-party identity was not normalized"

expect_identity_rejection "an implicit third-party tap name" Acme/homebrew-tools
expect_identity_rejection "a nonconventional third-party repository" Acme/tools Acme/tools
expect_identity_rejection "a mismatched third-party tap name" Acme/homebrew-tools Acme/other
expect_identity_rejection "a renamed first-party tap" \
  Automattic/kandelo-homebrew Automattic/kandelo
expect_identity_rejection "a conventional repository alias for the first-party tap" \
  Automattic/homebrew-kandelo-homebrew Automattic/kandelo-homebrew

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

collision_provenance="$TMPDIR/collision-dependency-provenance.json"
jq -nS '{
  schema: 2,
  formula: "hello",
  arch: "wasm32",
  tap_repository: "Automattic/homebrew-kandelo-homebrew",
  tap_name: "automattic/kandelo-homebrew",
  tap_commit: ("a" * 40),
  bottle_root_url: "https://ghcr.io/v2/automattic/homebrew-kandelo-homebrew",
  bottle_tag: "wasm32_kandelo",
  dependencies: []
}' >"$collision_provenance"
if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
  --input "$collision_provenance" \
  --formula hello \
  --arch wasm32 \
  --tap-repository Automattic/homebrew-kandelo-homebrew \
  --tap-name Automattic/kandelo-homebrew \
  --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --bottle-root-url https://ghcr.io/v2/automattic/homebrew-kandelo-homebrew \
  >/dev/null 2>&1; then
  fail "dependency provenance accepted an alias for the protected first-party tap"
fi

if python3 "$REPO_ROOT/scripts/homebrew-oci-layout.py" source-closure \
  --tap-root "$REPO_ROOT" \
  --kandelo-root "$REPO_ROOT" \
  --tap-repository Acme/homebrew-tools \
  --tap-name Acme/other \
  --formula hello \
  --out "$TMPDIR/source-closure.json" >/dev/null 2>&1; then
  fail "OCI source closure accepted a mismatched repository and tap name"
fi

if python3 "$REPO_ROOT/scripts/homebrew-oci-layout.py" source-closure \
  --tap-root "$REPO_ROOT" \
  --kandelo-root "$REPO_ROOT" \
  --tap-repository Automattic/homebrew-kandelo-homebrew \
  --tap-name Automattic/kandelo-homebrew \
  --formula hello \
  --out "$TMPDIR/collision-source-closure.json" >/dev/null 2>&1; then
  fail "OCI source closure accepted an alias for the protected first-party tap"
fi

printf '{}\n' >"$TMPDIR/runtime-evidence.json"
runtime_collision_error="$TMPDIR/runtime-collision.err"
if python3 "$REPO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" validate \
  --input "$TMPDIR/runtime-evidence.json" \
  --formula hello \
  --arch wasm32 \
  --abi 1 \
  --tap-repository Automattic/homebrew-kandelo-homebrew \
  --tap-name Automattic/kandelo-homebrew \
  --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --tap-root "$REPO_ROOT" \
  --bottle-root-url https://ghcr.io/v2/automattic/homebrew-kandelo-homebrew \
  --bottle-json "$TMPDIR/runtime-evidence.json" \
  --bottle-url "https://ghcr.io/v2/automattic/homebrew-kandelo-homebrew/hello/blobs/sha256:$(printf '0%.0s' {1..64})" \
  --bottle-sha256 "$(printf '0%.0s' {1..64})" \
  --bottle-bytes 1 \
  --dependency-provenance "$collision_provenance" \
  >/dev/null 2>"$runtime_collision_error"; then
  fail "runtime evidence accepted an alias for the protected first-party tap"
fi
grep -F "protected first-party tap name cannot be derived from another repository" \
  "$runtime_collision_error" >/dev/null ||
  fail "runtime evidence did not reject the first-party alias at the identity boundary"

echo "test-homebrew-tap-identity.sh: ok"
