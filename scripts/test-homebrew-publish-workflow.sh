#!/usr/bin/env bash
# Focused checks for the trusted Homebrew publish workflow helper scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "test-homebrew-publish-workflow.sh: $*" >&2
  exit 1
}

make_tap() {
  local tap="$1"
  mkdir -p "$tap/Formula" "$tap/Kandelo"
  cat >"$tap/Formula/hello.rb" <<'EOF'
class Hello < Formula
end
EOF
  cat >"$tap/Kandelo/metadata.json" <<'EOF'
{"last":"green"}
EOF
  git -C "$tap" init -q
  git -C "$tap" config user.name "Kandelo Test"
  git -C "$tap" config user.email "kandelo-test@example.invalid"
  git -C "$tap" add .
  git -C "$tap" commit -q -m "initial tap"
}

assert_matrix() {
  local tap="$TMPDIR/matrix-tap"
  make_tap "$tap"
  local matrix
  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm64,wasm32")"
  printf '%s\n' "$matrix" | jq -e '
    length == 2 and
    .[0] == {"formula":"hello","arch":"wasm32"} and
    .[1] == {"formula":"hello","arch":"wasm64"}
  ' >/dev/null || fail "unexpected matrix: $matrix"
}

assert_upload_dry_run() {
  local bottle="$TMPDIR/hello.bottle.tar.gz"
  local out="$TMPDIR/upload.env"
  printf 'bottle-bytes' >"$bottle"
  bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --tap-repository Automattic/kandelo-homebrew \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --bottle "$bottle" \
    --out-env "$out" \
    --dry-run >/dev/null
  # shellcheck disable=SC1090
  . "$out"
  [ "${BOTTLE_BYTES:-}" = "12" ] || fail "unexpected bottle byte count"
  case "${BOTTLE_URL:-}" in
    https://ghcr.io/v2/automattic/kandelo-homebrew/hello/blobs/sha256:*) ;;
    *) fail "unexpected bottle URL: ${BOTTLE_URL:-}" ;;
  esac
}

assert_upload_push_uses_relative_layer_path() {
  local bottle="$TMPDIR/hello.bottle.tar.gz"
  local out="$TMPDIR/upload.env"
  local bin="$TMPDIR/bin"
  local log="$TMPDIR/oras.log"
  printf 'bottle-bytes' >"$bottle"
  mkdir -p "$bin"
  cat >"$bin/oras" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$ORAS_LOG"
case "${1:-}" in
  login) cat >/dev/null ;;
  push) ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$bin/oras"
  ORAS_LOG="$log" GH_TOKEN="test-token" GITHUB_ACTOR="test-actor" PATH="$bin:$PATH" \
    bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
      --tap-repository Automattic/kandelo-homebrew \
      --formula hello \
      --arch wasm32 \
      --release-tag bottles-abi-v15 \
      --bottle "$bottle" \
      --out-env "$out" >/dev/null
  grep -F "push ghcr.io/automattic/kandelo-homebrew/hello:bottles-abi-v15-wasm32-" "$log" >/dev/null ||
    fail "oras push was not invoked"
  grep -F "hello.bottle.tar.gz:application/vnd.homebrew.bottle.layer.v1+gzip" "$log" >/dev/null ||
    fail "oras push did not use relative bottle layer path"
  ! grep -F "$bottle:application/vnd.homebrew.bottle.layer.v1+gzip" "$log" >/dev/null ||
    fail "oras push used an absolute bottle layer path"
}

assert_failure_preserves_metadata() {
  local tap="$TMPDIR/failure-tap"
  make_tap "$tap"
  local before after
  before="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "intentional test failure" \
    --dry-run \
    --no-lock >/dev/null
  after="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  [ "$before" = "$after" ] || fail "failure path modified metadata.json"
  find "$tap/Kandelo/reports/failures" -type f -name '*-hello-wasm32.json' -print -quit |
    grep -q . || fail "failure path did not write failure report"
}

assert_matrix
assert_upload_dry_run
assert_upload_push_uses_relative_layer_path
assert_failure_preserves_metadata

echo "test-homebrew-publish-workflow.sh: ok"
