#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KERNEL=""
KANDELO_REF=""
WORKFLOW_REF=""
TAP_CATALOG_REF=""
TAP_AUTHORITY_REF=""
CANARY_REF=""
SOURCE_ROOT="$REPO_ROOT"
OUT=""

usage() {
  echo \
    "usage: $0 --kernel <kernel.wasm> --kandelo-ref <sha> " \
    "--workflow-ref <sha> --tap-catalog-ref <sha> " \
    "--tap-authority-ref <sha> --canary-ref <sha> " \
    "[--source-root <directory>] --out <directory>" \
    >&2
  exit 2
}

while (( $# > 0 )); do
  case "$1" in
    --kernel)
      (( $# >= 2 )) || usage
      KERNEL="$2"
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
    --source-root)
      (( $# >= 2 )) || usage
      SOURCE_ROOT="$2"
      shift 2
      ;;
    --out)
      (( $# >= 2 )) || usage
      OUT="$2"
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
[[ -n "$KERNEL" && -n "$OUT" ]] || usage
KERNEL="$(cd "$(dirname "$KERNEL")" && pwd)/$(basename "$KERNEL")"
SOURCE_ROOT="$(cd "$SOURCE_ROOT" && pwd)"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"

if [[ ! -f "$KERNEL" || -L "$KERNEL" ]]; then
  echo "Node proof kernel must be a regular non-symlink file: $KERNEL" >&2
  exit 1
fi
if [[ -e "$OUT" ]]; then
  echo "Node proof runtime output already exists: $OUT" >&2
  exit 1
fi
if [[ "$(git -C "$SOURCE_ROOT" rev-parse HEAD)" != "$KANDELO_REF" ]]; then
  echo "Node proof runtime source does not match --kandelo-ref" >&2
  exit 1
fi
if [[ -n "$(git -C "$SOURCE_ROOT" status \
  --porcelain=v1 --untracked-files=all)" ]]; then
  echo "Node proof runtime source checkout is not clean" >&2
  exit 1
fi

for tool in jq node npm npx; do
  command -v "$tool" >/dev/null || {
    echo "Node proof runtime builder is missing $tool" >&2
    exit 1
  }
done
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo "Node proof runtime must be prepared with Node.js 24" >&2
  exit 1
fi

mkdir -p "$OUT/node/dist" "$OUT/node/wasm"

# WHY: the proof must execute the same compiled worker path as a packaged
# host. Building it before the handoff also keeps TypeScript compilers and the
# dependency installation out of the memory-constrained proof job.
npm --prefix "$SOURCE_ROOT/host" run build

build_bundle() {
  local entry="$1"
  local output="$2"
  (
    cd "$SOURCE_ROOT"
    npx --no-install esbuild "$entry" \
      --bundle \
      --format=esm \
      --legal-comments=none \
      --log-level=warning \
      --platform=node \
      --target=node24 \
      --outfile="$output"
  )
}

build_bundle \
  "$SOURCE_ROOT/homebrew/test/homebrew_guest_lifecycle_node.ts" \
  "$OUT/node/dist/homebrew-guest-lifecycle-node.js"
build_bundle \
  "$SOURCE_ROOT/host/dist/node-kernel-worker-entry.js" \
  "$OUT/node/dist/node-kernel-worker-entry.js"
build_bundle \
  "$SOURCE_ROOT/host/dist/worker-entry.js" \
  "$OUT/node/dist/worker-entry.js"
cp "$KERNEL" "$OUT/node/wasm/kandelo-kernel.wasm"

jq -n '
  {
    name: "kandelo-homebrew-node-proof-runtime",
    private: true,
    type: "module",
    engines: { node: ">=24 <25" }
  }
' >"$OUT/node/package.json"

sha256_file() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

file_bytes() {
  wc -c <"$1" | tr -d '[:space:]'
}

manifest_file() {
  local relative="$1"
  local path="$OUT/$relative"
  jq -n \
    --arg sha256 "$(sha256_file "$path")" \
    --argjson bytes "$(file_bytes "$path")" \
    '{ sha256: $sha256, bytes: $bytes }'
}

jq -n \
  --arg kandelo_ref "$KANDELO_REF" \
  --arg workflow_ref "$WORKFLOW_REF" \
  --arg tap_catalog_ref "$TAP_CATALOG_REF" \
  --arg tap_authority_ref "$TAP_AUTHORITY_REF" \
  --arg canary_ref "$CANARY_REF" \
  --arg node_version "$(node -p 'process.versions.node')" \
  --argjson package "$(manifest_file node/package.json)" \
  --argjson lifecycle "$(
    manifest_file node/dist/homebrew-guest-lifecycle-node.js
  )" \
  --argjson kernel_worker "$(
    manifest_file node/dist/node-kernel-worker-entry.js
  )" \
  --argjson process_worker "$(manifest_file node/dist/worker-entry.js)" \
  --argjson kernel "$(manifest_file node/wasm/kandelo-kernel.wasm)" '
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
        prepared_with: $node_version,
        host_limits: {
          max_workers: 4
        }
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
' >"$OUT/handoff.json"

bash "$REPO_ROOT/scripts/verify-homebrew-node-proof-runtime-handoff.sh" \
  --root "$OUT" \
  --kandelo-ref "$KANDELO_REF" \
  --workflow-ref "$WORKFLOW_REF" \
  --tap-catalog-ref "$TAP_CATALOG_REF" \
  --tap-authority-ref "$TAP_AUTHORITY_REF" \
  --canary-ref "$CANARY_REF"
