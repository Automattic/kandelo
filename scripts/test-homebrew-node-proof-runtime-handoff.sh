#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERIFY="$REPO_ROOT/scripts/verify-homebrew-node-proof-runtime-handoff.sh"
KANDELO_REF="0123456789abcdef0123456789abcdef01234567"
WORKFLOW_REF="123456789abcdef0123456789abcdef012345678"
TAP_CATALOG_REF="23456789abcdef0123456789abcdef0123456789"
TAP_AUTHORITY_REF="3456789abcdef0123456789abcdef0123456789a"
CANARY_REF="456789abcdef0123456789abcdef0123456789ab"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

sha256_file() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

file_record() {
  local path="$1"
  jq -n \
    --arg sha256 "$(sha256_file "$path")" \
    --argjson bytes "$(wc -c <"$path" | tr -d '[:space:]')" \
    '{ sha256: $sha256, bytes: $bytes }'
}

make_fixture() {
  local root="$1"
  mkdir -p "$root/node/dist" "$root/node/wasm"
  jq -n '
    {
      name: "kandelo-homebrew-node-proof-runtime",
      private: true,
      type: "module",
      engines: { node: ">=24 <25" }
    }
  ' >"$root/node/package.json"
  printf '%s\n' 'process.exitCode = 0;' \
    >"$root/node/dist/homebrew-guest-lifecycle-node.js"
  printf '%s\n' 'process.exitCode = 0;' \
    >"$root/node/dist/node-kernel-worker-entry.js"
  printf '%s\n' 'process.exitCode = 0;' \
    >"$root/node/dist/worker-entry.js"
  printf '\0asm\1\0\0\0' >"$root/node/wasm/kandelo-kernel.wasm"
  jq -n \
    --arg kandelo_ref "$KANDELO_REF" \
    --arg workflow_ref "$WORKFLOW_REF" \
    --arg tap_catalog_ref "$TAP_CATALOG_REF" \
    --arg tap_authority_ref "$TAP_AUTHORITY_REF" \
    --arg canary_ref "$CANARY_REF" \
    --argjson package "$(file_record "$root/node/package.json")" \
    --argjson lifecycle "$(
      file_record "$root/node/dist/homebrew-guest-lifecycle-node.js"
    )" \
    --argjson kernel_worker "$(
      file_record "$root/node/dist/node-kernel-worker-entry.js"
    )" \
    --argjson process_worker "$(
      file_record "$root/node/dist/worker-entry.js"
    )" \
    --argjson kernel "$(
      file_record "$root/node/wasm/kandelo-kernel.wasm"
    )" '
    {
      schema: 1,
      kind: "kandelo-homebrew-node-proof-runtime-handoff",
      authorities: {
        kandelo_ref: $kandelo_ref,
        workflow_ref: $workflow_ref,
        tap_catalog_ref: $tap_catalog_ref,
        tap_authority_ref: $tap_authority_ref,
        canary_ref: $canary_ref
      },
      runtimes: {
        node: {
          major: 24,
          prepared_with: "24.0.0",
          host_limits: { max_workers: 4 }
        }
      },
      files: {
        "node/package.json": $package,
        "node/dist/homebrew-guest-lifecycle-node.js": $lifecycle,
        "node/dist/node-kernel-worker-entry.js": $kernel_worker,
        "node/dist/worker-entry.js": $process_worker,
        "node/wasm/kandelo-kernel.wasm": $kernel
      }
    }
  ' >"$root/handoff.json"
}

expect_rejected() {
  local root="$1"
  if bash "$VERIFY" \
    --root "$root" \
    --kandelo-ref "$KANDELO_REF" \
    --workflow-ref "$WORKFLOW_REF" \
    --tap-catalog-ref "$TAP_CATALOG_REF" \
    --tap-authority-ref "$TAP_AUTHORITY_REF" \
    --canary-ref "$CANARY_REF" >/dev/null 2>&1; then
    echo "runtime verifier accepted invalid fixture: $root" >&2
    exit 1
  fi
}

valid="$TMP_ROOT/valid"
make_fixture "$valid"
bash "$VERIFY" \
  --root "$valid" \
  --kandelo-ref "$KANDELO_REF" \
  --workflow-ref "$WORKFLOW_REF" \
  --tap-catalog-ref "$TAP_CATALOG_REF" \
  --tap-authority-ref "$TAP_AUTHORITY_REF" \
  --canary-ref "$CANARY_REF"

tampered="$TMP_ROOT/tampered"
cp -R "$valid" "$tampered"
printf '%s\n' 'process.exitCode = 1;' \
  >"$tampered/node/dist/homebrew-guest-lifecycle-node.js"
expect_rejected "$tampered"

extra="$TMP_ROOT/extra"
cp -R "$valid" "$extra"
printf '%s\n' unexpected >"$extra/unexpected"
expect_rejected "$extra"

wrong_limit="$TMP_ROOT/wrong-limit"
cp -R "$valid" "$wrong_limit"
jq '.runtimes.node.host_limits.max_workers = 3' \
  "$wrong_limit/handoff.json" >"$wrong_limit/changed.json"
mv "$wrong_limit/changed.json" "$wrong_limit/handoff.json"
expect_rejected "$wrong_limit"

symlinked="$TMP_ROOT/symlinked"
cp -R "$valid" "$symlinked"
ln -sf ../homebrew-guest-lifecycle-node.js \
  "$symlinked/node/dist/worker-entry.js"
expect_rejected "$symlinked"

wrong_ref="$TMP_ROOT/wrong-ref"
cp -R "$valid" "$wrong_ref"
if bash "$VERIFY" \
  --root "$wrong_ref" \
  --kandelo-ref fedcba9876543210fedcba9876543210fedcba98 \
  --workflow-ref "$WORKFLOW_REF" \
  --tap-catalog-ref "$TAP_CATALOG_REF" \
  --tap-authority-ref "$TAP_AUTHORITY_REF" \
  --canary-ref "$CANARY_REF" \
  >/dev/null 2>&1; then
  echo "runtime verifier accepted the wrong Kandelo authority" >&2
  exit 1
fi

echo "test-homebrew-node-proof-runtime-handoff.sh: ok"
