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

assert_matrix_skips_unchanged_cache_key() {
  local tap="$TMPDIR/matrix-skip-tap"
  local expected="$TMPDIR/expected-cache-keys.json"
  make_tap "$tap"
  cat >"$tap/Kandelo/metadata.json" <<'EOF'
{
  "packages": [
    {
      "name": "hello",
      "bottles": [
        {
          "arch": "wasm32",
          "status": "success",
          "cache_key_sha": "cache-key-current"
        },
        {
          "arch": "wasm64",
          "status": "success",
          "cache_key_sha": "cache-key-old"
        }
      ]
    }
  ]
}
EOF
  cat >"$expected" <<'EOF'
{
  "hello": {
    "wasm32": "cache-key-current",
    "wasm64": "cache-key-new"
  }
}
EOF
  local matrix
  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm64,wasm32" \
    --expected-cache-keys "$expected")"
  printf '%s\n' "$matrix" | jq -e '
    length == 1 and
    .[0] == {"formula":"hello","arch":"wasm64"}
  ' >/dev/null || fail "expected unchanged wasm32 entry to be skipped: $matrix"

  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm64,wasm32" \
    --expected-cache-keys "$expected" \
    --force)"
  printf '%s\n' "$matrix" | jq -e '
    length == 2 and
    .[0] == {"formula":"hello","arch":"wasm32"} and
    .[1] == {"formula":"hello","arch":"wasm64"}
  ' >/dev/null || fail "expected force to include unchanged cache keys: $matrix"
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

assert_failed_payload_rejects_success_status() {
  local tap="$TMPDIR/failure-payload-tap"
  local payload="$TMPDIR/failure-success-payload"
  local err="$TMPDIR/failure-success-payload.err"
  make_tap "$tap"
  mkdir -p "$payload/Kandelo"
  cat >"$payload/Kandelo/metadata.json" <<'EOF'
{
  "packages": [
    {
      "name": "hello",
      "bottles": [
        {
          "arch": "wasm32",
          "status": "success"
        }
      ]
    }
  ]
}
EOF
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --sidecar-root "$payload" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --dry-run \
    --no-lock > /dev/null 2>"$err"; then
    fail "failed publish accepted a success sidecar payload"
  fi
  grep -q "missing a non-success status" "$err" ||
    fail "failed publish did not explain rejected success payload"
}

assert_rollback_preserves_metadata() {
  local tap="$TMPDIR/rollback-tap"
  make_tap "$tap"
  local before after report
  before="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status rollback \
    --reason "bad bottle block selected by tap commit" \
    --rollback-ref "refs/heads/main~1" \
    --dry-run \
    --no-lock >/dev/null
  after="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  [ "$before" = "$after" ] || fail "rollback path modified metadata.json"
  report="$(find "$tap/Kandelo/reports/rollbacks" -type f -name '*-hello-wasm32.json' -print -quit)"
  [ -n "$report" ] || fail "rollback path did not write rollback report"
  jq -e '
    .status == "rollback" and
    .rollback_ref == "refs/heads/main~1" and
    .package_deletion.performed == false and
    (.package_deletion.policy | contains("exceptional"))
  ' "$report" >/dev/null || fail "rollback report did not record rollback policy"
}

assert_rollback_deletion_requires_reason() {
  local tap="$TMPDIR/rollback-deletion-tap"
  local err="$TMPDIR/rollback-deletion.err"
  make_tap "$tap"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status rollback \
    --reason "legal package removal" \
    --deleted-package-url "https://ghcr.io/v2/example/package/blobs/sha256:bad" \
    --dry-run \
    --no-lock > /dev/null 2>"$err"; then
    fail "rollback package deletion without reason unexpectedly succeeded"
  fi
  grep -q -- "--deletion-reason is required" "$err" ||
    fail "rollback deletion did not explain missing deletion reason"
}

workflow_uses_actions_cache() {
  grep -Eq "uses:[[:space:]]+['\"]?actions/cache(/restore)?@" "$@"
}

workflow_run_expressions() {
  awk '
    function indentation(line) {
      match(line, /^[[:space:]]*/)
      return RLENGTH
    }
    /^[[:space:]]+run:[[:space:]]+\|[+-]?[[:space:]]*$/ {
      in_run = 1
      run_indent = indentation($0)
      next
    }
    in_run {
      if ($0 !~ /^[[:space:]]*$/ && indentation($0) <= run_indent) {
        in_run = 0
      }
      if (in_run && index($0, "${{") != 0) {
        print FNR ":" $0
      }
    }
  ' "$@"
}

assert_publisher_trust_contract() {
  local publisher="$REPO_ROOT/.github/workflows/reusable-homebrew-bottle-publish.yml"
  local maintenance="$REPO_ROOT/.github/workflows/reusable-homebrew-bottle-maintenance.yml"
  local first_checkout_line
  local inline_expressions
  local magic_nix
  local rebuild_job
  local validation_line

  if grep -Eq '^[[:space:]]*permissions:' "$publisher"; then
    fail "reusable publisher requests permissions instead of inheriting its caller scope"
  fi
  if workflow_uses_actions_cache "$publisher" "$maintenance"; then
    fail "reusable publisher consumes caller-writable Actions cache state"
  fi
  printf '%s\n' 'uses: "actions/cache/restore@v4"' | workflow_uses_actions_cache ||
    fail "publisher cache detector misses quoted restore actions"
  magic_nix="$(grep -F -A5 'uses: DeterminateSystems/magic-nix-cache-action@' "$publisher")"
  printf '%s\n' "$magic_nix" | grep -Fx '          use-gha-cache: false' >/dev/null ||
    fail "reusable publisher enables Magic Nix GitHub Actions caching"
  printf '%s\n' "$magic_nix" | grep -Fx '          use-flakehub: false' >/dev/null ||
    fail "reusable publisher enables Magic Nix FlakeHub caching"
  grep -Fx \
    '        uses: Homebrew/actions/setup-homebrew@1f8e202ffddf94def7f42f6fa3a482e821489f9c' \
    "$publisher" >/dev/null || fail "Homebrew setup action is not pinned to the reviewed commit"
  grep -Fx '      - name: Validate caller trust boundary' "$publisher" >/dev/null ||
    fail "reusable publisher does not validate write-path refs before checkout"
  validation_line="$(grep -nF '      - name: Validate caller trust boundary' "$publisher" | head -n1 | cut -d: -f1)"
  first_checkout_line="$(grep -nE '^[[:space:]]+- name: Checkout ' "$publisher" | head -n1 | cut -d: -f1)"
  if [ -z "$first_checkout_line" ] || [ "$validation_line" -ge "$first_checkout_line" ]; then
    fail "reusable publisher does not validate caller trust before checkout"
  fi
  grep -F '[ "$KANDELO_REF" = "main" ]' "$publisher" >/dev/null ||
    fail "reusable publisher does not constrain write publication to Kandelo main"
  grep -F '[ "$TAP_REF" = "main" ]' "$publisher" >/dev/null ||
    fail "reusable publisher does not constrain write publication to tap main"

  if grep -Fx '  workflow_dispatch:' "$maintenance" >/dev/null; then
    fail "write-capable maintenance is directly dispatchable from an arbitrary workflow ref"
  fi
  if grep -F '${{ inputs.kandelo-ref }}' "$maintenance" >/dev/null ||
     grep -F '${{ inputs.tap-ref }}' "$maintenance" >/dev/null ||
     grep -F '${{ inputs.sidecar-command }}' "$maintenance" >/dev/null ||
     grep -F '${{ inputs.dry-run }}' "$maintenance" >/dev/null; then
    fail "trusted maintenance executes caller-selected code or commands with write authority"
  fi

  rebuild_job="$(awk '
    $0 == "  rebuild-or-repair:" { capture = 1 }
    capture && $0 ~ /^  [[:alnum:]_-]+:$/ && $0 != "  rebuild-or-repair:" { exit }
    capture { print }
  ' "$maintenance")"
  printf '%s\n' "$rebuild_job" | grep -Fx '    permissions:' >/dev/null ||
    fail "trusted maintenance caller does not own an explicit permissions block"
  printf '%s\n' "$rebuild_job" | grep -Fx '      contents: write' >/dev/null ||
    fail "trusted maintenance caller lacks contents: write"
  printf '%s\n' "$rebuild_job" | grep -Fx '      packages: write' >/dev/null ||
    fail "trusted maintenance caller lacks packages: write"
  printf '%s\n' "$rebuild_job" | grep -Fx '      actions: read' >/dev/null ||
    fail "trusted maintenance caller lacks actions: read"
  printf '%s\n' "$rebuild_job" |
    grep -Fx '    uses: ./.github/workflows/reusable-homebrew-bottle-publish.yml' >/dev/null ||
    fail "trusted maintenance permissions are not attached to the publisher call job"
  printf '%s\n' "$rebuild_job" | grep -Fx '      kandelo-ref: main' >/dev/null ||
    fail "trusted maintenance does not publish from Kandelo main"
  printf '%s\n' "$rebuild_job" | grep -Fx '      tap-ref: main' >/dev/null ||
    fail "trusted maintenance does not publish from tap main"
  printf '%s\n' "$rebuild_job" | grep -Fx '      dry-run: false' >/dev/null ||
    fail "trusted maintenance exposes a dry run with a write-scoped token"

  inline_expressions="$(workflow_run_expressions "$publisher" "$maintenance")"
  if [ -n "$inline_expressions" ]; then
    printf '%s\n' "$inline_expressions" >&2
    fail "write-capable workflows interpolate GitHub expressions directly into shell syntax"
  fi
  inline_expressions="$(
    printf '%s\n' \
      'jobs:' \
      '  privileged:' \
      '    steps:' \
      '      - name: Injected' \
      '        run: |' \
      '          echo "${{ inputs.formulae }}"' |
      workflow_run_expressions
  )"
  [ -n "$inline_expressions" ] ||
    fail "publisher shell-expression detector misses workflow inputs"
}

assert_matrix
assert_matrix_skips_unchanged_cache_key
assert_upload_dry_run
assert_upload_push_uses_relative_layer_path
assert_failure_preserves_metadata
assert_failed_payload_rejects_success_status
assert_rollback_preserves_metadata
assert_rollback_deletion_requires_reason
assert_publisher_trust_contract

echo "test-homebrew-publish-workflow.sh: ok"
