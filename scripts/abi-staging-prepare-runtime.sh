#!/usr/bin/env bash
# Build and describe one exact-head kernel/host/browser runtime without credentials.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SOURCE_ROOT=""
SOURCE_REPOSITORY=""
SOURCE_COMMIT=""
SOURCE_TREE=""
TARGET_ABI=""
SNAPSHOT_SHA256=""
BUILD_POLICY_SHA256=""
OUT=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/abi-staging-prepare-runtime.sh --source-root <dir> --source-repository <owner/repo> --source-commit <sha> --source-tree <sha> --target-abi <N> --snapshot-sha256 <sha256> --build-policy-sha256 <sha256> --out <dir>
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-root) SOURCE_ROOT="${2:-}"; shift 2 ;;
    --source-repository) SOURCE_REPOSITORY="${2:-}"; shift 2 ;;
    --source-commit) SOURCE_COMMIT="${2:-}"; shift 2 ;;
    --source-tree) SOURCE_TREE="${2:-}"; shift 2 ;;
    --target-abi) TARGET_ABI="${2:-}"; shift 2 ;;
    --snapshot-sha256) SNAPSHOT_SHA256="${2:-}"; shift 2 ;;
    --build-policy-sha256) BUILD_POLICY_SHA256="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "abi-staging-prepare-runtime.sh: unknown flag: $1" >&2
      usage
      exit 2
      ;;
  esac
done

for required in SOURCE_ROOT SOURCE_REPOSITORY SOURCE_COMMIT SOURCE_TREE \
  TARGET_ABI SNAPSHOT_SHA256 BUILD_POLICY_SHA256 OUT; do
  if [ -z "${!required}" ]; then
    echo "abi-staging-prepare-runtime.sh: --${required,,} is required" >&2
    exit 2
  fi
done
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"

if ! [[ "$SOURCE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "abi-staging-prepare-runtime.sh: invalid source repository" >&2
  exit 2
fi
if ! [[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || \
   ! [[ "$SOURCE_TREE" =~ ^[0-9a-f]{40}$ ]]; then
  echo "abi-staging-prepare-runtime.sh: invalid exact source identity" >&2
  exit 2
fi
if ! [[ "$TARGET_ABI" =~ ^[1-9][0-9]*$ ]] || [ "$TARGET_ABI" -gt 4294967295 ]; then
  echo "abi-staging-prepare-runtime.sh: invalid target ABI" >&2
  exit 2
fi
if ! [[ "$SNAPSHOT_SHA256" =~ ^[0-9a-f]{64}$ ]] || \
   ! [[ "$BUILD_POLICY_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "abi-staging-prepare-runtime.sh: invalid policy or snapshot digest" >&2
  exit 2
fi

for secret_name in \
  GITHUB_TOKEN GH_TOKEN GHCR_PAT HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN \
  NPM_TOKEN NODE_AUTH_TOKEN SSH_AUTH_SOCK AWS_ACCESS_KEY_ID \
  AWS_SECRET_ACCESS_KEY ACTIONS_ID_TOKEN_REQUEST_TOKEN; do
  if [ -n "${!secret_name:-}" ]; then
    echo "abi-staging-prepare-runtime.sh: candidate runtime received credential $secret_name" >&2
    exit 2
  fi
done

if [ ! -d "$SOURCE_ROOT" ] || [ -L "$SOURCE_ROOT" ]; then
  echo "abi-staging-prepare-runtime.sh: source root must be a real directory" >&2
  exit 2
fi
SOURCE_ROOT="$(cd "$SOURCE_ROOT" && pwd -P)"
ACTUAL_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD)"
ACTUAL_TREE="$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD^{tree})"
if [ "$ACTUAL_COMMIT" != "$SOURCE_COMMIT" ] || [ "$ACTUAL_TREE" != "$SOURCE_TREE" ]; then
  echo "abi-staging-prepare-runtime.sh: checkout is not the exact source head and tree" >&2
  exit 1
fi
if [ -n "$(git -C "$SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "abi-staging-prepare-runtime.sh: exact source has tracked or untracked changes" >&2
  exit 1
fi
if [ ! -f "$SOURCE_ROOT/abi/snapshot.json" ] || \
   [ -L "$SOURCE_ROOT/abi/snapshot.json" ] || \
   [ "$(sha256sum "$SOURCE_ROOT/abi/snapshot.json" | awk '{print $1}')" != \
     "$SNAPSHOT_SHA256" ]; then
  echo "abi-staging-prepare-runtime.sh: exact source snapshot differs" >&2
  exit 1
fi

OUT="$(python3 - "$OUT" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).resolve(strict=False))
PY
)"
case "$OUT" in
  "$SOURCE_ROOT"|"$SOURCE_ROOT"/*)
    echo "abi-staging-prepare-runtime.sh: output must be outside the exact source tree" >&2
    exit 2
    ;;
esac

if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  if [ ! -d "$OUT" ] || [ -L "$OUT" ] || \
     [ -n "$(find "$OUT" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "abi-staging-prepare-runtime.sh: output must be new or an empty real directory" >&2
    exit 2
  fi
else
  mkdir -p "$OUT"
fi
OUT="$(cd "$OUT" && pwd -P)"
RUNTIME_ROOT="$OUT/runtime"
mkdir "$RUNTIME_ROOT"

TESTING="${KANDELO_ABI_STAGING_TESTING:-0}"
TEST_BUILDER="${KANDELO_ABI_STAGING_RUNTIME_BUILDER:-}"
if [ "$TESTING" != 0 ] && [ "$TESTING" != 1 ]; then
  echo "abi-staging-prepare-runtime.sh: invalid test mode" >&2
  exit 2
fi
if [ -n "$TEST_BUILDER" ] && { [ "$TESTING" != 1 ] || [ "${GITHUB_ACTIONS:-}" = true ]; }; then
  echo "abi-staging-prepare-runtime.sh: runtime builder replacement is local-test-only" >&2
  exit 2
fi

run_without_credentials() {
  env \
    -u GITHUB_TOKEN -u GH_TOKEN -u GHCR_PAT \
    -u HOMEBREW_GITHUB_API_TOKEN -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
    -u HOMEBREW_DOCKER_REGISTRY_TOKEN -u NPM_TOKEN -u NODE_AUTH_TOKEN \
    -u SSH_AUTH_SOCK -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
    -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    "$@"
}

if [ -n "$TEST_BUILDER" ]; then
  if [ ! -f "$TEST_BUILDER" ] || [ -L "$TEST_BUILDER" ] || [ ! -x "$TEST_BUILDER" ]; then
    echo "abi-staging-prepare-runtime.sh: test runtime builder is unavailable" >&2
    exit 2
  fi
  run_without_credentials "$TEST_BUILDER" "$SOURCE_ROOT" "$RUNTIME_ROOT"
else
  (
    cd "$SOURCE_ROOT"
    run_without_credentials bash build.sh
    run_without_credentials npm --prefix apps/browser-demos install --prefer-offline
    run_without_credentials npm --prefix apps/browser-demos run build
  )

  KERNEL_SOURCE="$SOURCE_ROOT/target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"
  HOST_SOURCE="$SOURCE_ROOT/host/dist"
  BROWSER_SOURCE="$SOURCE_ROOT/apps/browser-demos/dist"
  for required_path in \
    "$KERNEL_SOURCE" \
    "$SOURCE_ROOT/host/src/generated/abi.ts" \
    "$SOURCE_ROOT/host/src/worker-protocol.ts"; do
    if [ ! -f "$required_path" ] || [ -L "$required_path" ]; then
      echo "abi-staging-prepare-runtime.sh: runtime build output is unavailable: $required_path" >&2
      exit 1
    fi
  done
  for required_directory in "$HOST_SOURCE" "$BROWSER_SOURCE"; do
    if [ ! -d "$required_directory" ] || [ -L "$required_directory" ] || \
       [ -n "$(find "$required_directory" -type l -print -quit)" ]; then
      echo "abi-staging-prepare-runtime.sh: runtime bundle directory is invalid" >&2
      exit 1
    fi
  done
  mkdir -p "$RUNTIME_ROOT/host" "$RUNTIME_ROOT/browser"
  cp "$KERNEL_SOURCE" "$RUNTIME_ROOT/kernel.wasm"
  cp "$SOURCE_ROOT/host/src/generated/abi.ts" \
    "$RUNTIME_ROOT/host/generated-abi.ts"
  cp "$SOURCE_ROOT/host/src/worker-protocol.ts" \
    "$RUNTIME_ROOT/host/worker-protocol.ts"
  cp -R "$HOST_SOURCE" "$RUNTIME_ROOT/host/dist"
  cp -R "$BROWSER_SOURCE" "$RUNTIME_ROOT/browser/dist"
fi

if [ "$ACTUAL_COMMIT" != "$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD)" ] || \
   [ "$ACTUAL_TREE" != "$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD^{tree})" ] || \
   [ -n "$(git -C "$SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "abi-staging-prepare-runtime.sh: exact source changed during runtime build" >&2
  exit 1
fi

python3 - \
  "$RUNTIME_ROOT" "$OUT/runtime-bundle.json" \
  "$SOURCE_REPOSITORY" "$SOURCE_COMMIT" "$SOURCE_TREE" \
  "$TARGET_ABI" "$SNAPSHOT_SHA256" "$BUILD_POLICY_SHA256" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import sys

(
    runtime_text,
    bundle_text,
    repository,
    commit,
    tree,
    abi_text,
    snapshot_sha256,
    build_policy_sha256,
) = sys.argv[1:]
runtime = Path(runtime_text)
bundle_path = Path(bundle_text)

def canonical(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode()

def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()

def digest_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()

inventory: list[dict[str, object]] = []
total = 0
for directory, directories, files in os.walk(runtime, followlinks=False):
    for name in directories:
        path = Path(directory, name)
        if stat.S_ISLNK(path.lstat().st_mode):
            raise SystemExit(f"runtime inventory contains a symbolic link: {path}")
    for name in files:
        path = Path(directory, name)
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise SystemExit(f"runtime inventory contains a symbolic link: {path}")
        if not stat.S_ISREG(mode):
            raise SystemExit(f"runtime inventory contains a nonregular file: {path}")
        relative = path.relative_to(runtime).as_posix()
        size = path.stat().st_size
        if size < 0 or size > 8 * 1024 * 1024 * 1024 - total:
            raise SystemExit("runtime inventory exceeds its bounded limits")
        total += size
        if len(inventory) >= 32768:
            raise SystemExit("runtime inventory exceeds its bounded limits")
        inventory.append({"bytes": size, "path": relative, "sha256": digest_file(path)})
inventory.sort(key=lambda item: item["path"])

def entry(path: str) -> dict[str, object]:
    matches = [item for item in inventory if item["path"] == path]
    if len(matches) != 1:
        raise SystemExit(f"runtime inventory lacks exact file: {path}")
    return matches[0]

def subset(prefix: str) -> tuple[str, int]:
    selected = [item for item in inventory if str(item["path"]).startswith(prefix)]
    if not selected:
        raise SystemExit(f"runtime inventory lacks {prefix} files")
    return digest(canonical(selected)), sum(int(item["bytes"]) for item in selected)

kernel = entry("kernel.wasm")
generated_abi = entry("host/generated-abi.ts")
worker_protocol = entry("host/worker-protocol.ts")
service_worker = entry("browser/dist/service-worker.js")
host_sha256, host_bytes = subset("host/")
browser_sha256, browser_bytes = subset("browser/")
bundle = {
    "browser": {
        "bundle_sha256": browser_sha256,
        "bytes": browser_bytes,
        "service_worker_sha256": service_worker["sha256"],
    },
    "build_policy_sha256": build_policy_sha256,
    "host": {
        "bundle_sha256": host_sha256,
        "bytes": host_bytes,
        "generated_abi_sha256": generated_abi["sha256"],
        "worker_protocol_sha256": worker_protocol["sha256"],
    },
    "inventory": inventory,
    "kernel": {
        "abi_version": int(abi_text),
        "bytes": kernel["bytes"],
        "snapshot_sha256": snapshot_sha256,
        "wasm_sha256": kernel["sha256"],
    },
    "kind": "kandelo-exact-runtime-bundle",
    "schema": 1,
    "source": {"commit": commit, "repository": repository, "tree": tree},
    "target_abi": {"snapshot_sha256": snapshot_sha256, "version": int(abi_text)},
}
temporary = bundle_path.with_name(bundle_path.name + ".tmp")
temporary.write_bytes(canonical(bundle))
os.replace(temporary, bundle_path)
PY

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
(
  cd "$REPO_ROOT"
  cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
    abi-staging runtime-bundle validate \
      --bundle "$OUT/runtime-bundle.json" \
      --artifact-root "$RUNTIME_ROOT" \
      --source-root "$SOURCE_ROOT" \
      --repository "$SOURCE_REPOSITORY" \
      --commit "$SOURCE_COMMIT" \
      --tree "$SOURCE_TREE" \
      --abi "$TARGET_ABI" \
      --snapshot-sha256 "$SNAPSHOT_SHA256" \
      --build-policy-sha256 "$BUILD_POLICY_SHA256"
)

echo "abi-staging-prepare-runtime.sh: prepared exact uncredentialed runtime"
