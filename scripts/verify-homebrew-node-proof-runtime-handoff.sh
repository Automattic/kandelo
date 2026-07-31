#!/usr/bin/env bash
set -euo pipefail

ROOT=""
KANDELO_REF=""
WORKFLOW_REF=""
TAP_CATALOG_REF=""
TAP_AUTHORITY_REF=""
CANARY_REF=""
MAX_HANDOFF_BYTES=$((64 * 1024 * 1024))

usage() {
  echo \
    "usage: $0 --root <directory> --kandelo-ref <sha> " \
    "--workflow-ref <sha> --tap-catalog-ref <sha> " \
    "--tap-authority-ref <sha> --canary-ref <sha>" >&2
  exit 2
}

while (( $# > 0 )); do
  case "$1" in
    --root)
      (( $# >= 2 )) || usage
      ROOT="$2"
      shift 2
      ;;
    --kandelo-ref)
      (( $# >= 2 )) || usage
      KANDELO_REF="$2"
      shift 2
      ;;
    --workflow-ref)
      (( $# >= 2 )) || usage
      WORKFLOW_REF="$2"
      shift 2
      ;;
    --tap-catalog-ref)
      (( $# >= 2 )) || usage
      TAP_CATALOG_REF="$2"
      shift 2
      ;;
    --tap-authority-ref)
      (( $# >= 2 )) || usage
      TAP_AUTHORITY_REF="$2"
      shift 2
      ;;
    --canary-ref)
      (( $# >= 2 )) || usage
      CANARY_REF="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

for ref in \
  "$KANDELO_REF" "$WORKFLOW_REF" "$TAP_CATALOG_REF" \
  "$TAP_AUTHORITY_REF" "$CANARY_REF"
do
  [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || usage
done
[[ -n "$ROOT" ]] || usage
if [[ ! -d "$ROOT" || -L "$ROOT" ]]; then
  echo "Node proof runtime root must be a regular directory" >&2
  exit 1
fi

for tool in jq node; do
  command -v "$tool" >/dev/null || {
    echo "Node proof runtime verifier is missing $tool" >&2
    exit 1
  }
done
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo "Node proof runtime must execute with Node.js 24" >&2
  exit 1
fi

expected_entries="$(
  printf '%s\n' \
    ./handoff.json \
    ./node \
    ./node/dist \
    ./node/dist/homebrew-guest-lifecycle-node.js \
    ./node/dist/node-kernel-worker-entry.js \
    ./node/dist/worker-entry.js \
    ./node/package.json \
    ./node/wasm \
    ./node/wasm/kandelo-kernel.wasm
)"
actual_entries="$(
  cd "$ROOT"
  find . -mindepth 1 -print | LC_ALL=C sort
)"
if [[ "$actual_entries" != "$expected_entries" ]]; then
  echo "Node proof runtime inventory differs" >&2
  exit 1
fi

for relative in \
  handoff.json \
  node/package.json \
  node/dist/homebrew-guest-lifecycle-node.js \
  node/dist/node-kernel-worker-entry.js \
  node/dist/worker-entry.js \
  node/wasm/kandelo-kernel.wasm
do
  if [[ ! -f "$ROOT/$relative" || -L "$ROOT/$relative" ]]; then
    echo "Node proof runtime member is not a regular file: $relative" >&2
    exit 1
  fi
done

total_bytes="$(
  find "$ROOT" -type f -exec wc -c {} + |
    awk '{ total += $1 } END { print total + 0 }'
)"
if (( total_bytes > MAX_HANDOFF_BYTES )); then
  echo "Node proof runtime exceeds its 64 MiB bound" >&2
  exit 1
fi

if ! jq -e \
  --arg kandelo_ref "$KANDELO_REF" \
  --arg workflow_ref "$WORKFLOW_REF" \
  --arg tap_catalog_ref "$TAP_CATALOG_REF" \
  --arg tap_authority_ref "$TAP_AUTHORITY_REF" \
  --arg canary_ref "$CANARY_REF" '
  .schema == 1 and
  .kind == "kandelo-homebrew-node-proof-runtime-handoff" and
  .authorities == {
    kandelo_ref: $kandelo_ref,
    workflow_ref: $workflow_ref,
    tap_catalog_ref: $tap_catalog_ref,
    tap_authority_ref: $tap_authority_ref,
    canary_ref: $canary_ref
  } and
  .runtimes.node.major == 24 and
  (.runtimes.node.prepared_with | type == "string") and
  .runtimes.node.host_limits == { max_workers: 4 } and
  (keys | sort) == [
    "authorities",
    "files",
    "kind",
    "runtimes",
    "schema"
  ] and
  (.files | keys) == [
    "node/dist/homebrew-guest-lifecycle-node.js",
    "node/dist/node-kernel-worker-entry.js",
    "node/dist/worker-entry.js",
    "node/package.json",
    "node/wasm/kandelo-kernel.wasm"
  ] and
  all(
    .files[];
    (keys | sort) == ["bytes", "sha256"] and
    (.sha256 | test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and . > 0 and floor == .)
  )
' "$ROOT/handoff.json" >/dev/null; then
  echo "Node proof runtime manifest is invalid" >&2
  exit 1
fi

if ! jq -e '
  . == {
    name: "kandelo-homebrew-node-proof-runtime",
    private: true,
    type: "module",
    engines: { node: ">=24 <25" }
  }
' "$ROOT/node/package.json" >/dev/null; then
  echo "Node proof runtime package identity differs" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

for relative in \
  node/package.json \
  node/dist/homebrew-guest-lifecycle-node.js \
  node/dist/node-kernel-worker-entry.js \
  node/dist/worker-entry.js \
  node/wasm/kandelo-kernel.wasm
do
  expected_sha="$(
    jq -er --arg relative "$relative" \
      '.files[$relative].sha256' "$ROOT/handoff.json"
  )"
  expected_bytes="$(
    jq -er --arg relative "$relative" \
      '.files[$relative].bytes' "$ROOT/handoff.json"
  )"
  actual_sha="$(sha256_file "$ROOT/$relative")"
  actual_bytes="$(wc -c <"$ROOT/$relative" | tr -d '[:space:]')"
  if [[ "$actual_sha" != "$expected_sha" ||
    "$actual_bytes" != "$expected_bytes" ]]; then
    echo "Node proof runtime member differs from manifest: $relative" >&2
    exit 1
  fi
done

for relative in \
  node/dist/homebrew-guest-lifecycle-node.js \
  node/dist/node-kernel-worker-entry.js \
  node/dist/worker-entry.js
do
  node --check "$ROOT/$relative"
done

kernel_magic="$(
  od -An -N4 -tx1 "$ROOT/node/wasm/kandelo-kernel.wasm" |
    tr -d '[:space:]'
)"
if [[ "$kernel_magic" != "0061736d" ]]; then
  echo "Node proof runtime kernel is not WebAssembly" >&2
  exit 1
fi

echo "verify-homebrew-node-proof-runtime-handoff.sh: ok"
