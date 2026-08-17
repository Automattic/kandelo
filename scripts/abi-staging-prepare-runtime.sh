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
BINARY_CACHE_ROOT=""
OUT=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/abi-staging-prepare-runtime.sh --source-root <dir> --source-repository <owner/repo> --source-commit <sha> --source-tree <sha> --target-abi <N> --snapshot-sha256 <sha256> --build-policy-sha256 <sha256> --binary-cache-root <dir> --out <dir>
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
    --binary-cache-root) BINARY_CACHE_ROOT="${2:-}"; shift 2 ;;
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
  TARGET_ABI SNAPSHOT_SHA256 BUILD_POLICY_SHA256 BINARY_CACHE_ROOT OUT; do
  if [ -z "${!required}" ]; then
    echo "abi-staging-prepare-runtime.sh: --${required,,} is required" >&2
    exit 2
  fi
done
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"
: "${KANDELO_NIX_BIN:?run through scripts/dev-shell.sh}"

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
  AWS_SECRET_ACCESS_KEY ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  ACTIONS_RUNTIME_TOKEN; do
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
BINARY_CACHE_ROOT="$(python3 - "$BINARY_CACHE_ROOT" <<'PY'
from pathlib import Path
import stat
import sys
path = Path(sys.argv[1])
if not path.is_absolute():
    raise SystemExit("binary cache root must be absolute")
current = Path(path.anchor)
for component in path.parts[1:]:
    current /= component
    try:
        mode = current.lstat().st_mode
    except FileNotFoundError:
        raise SystemExit("binary cache root must be a real directory")
    if stat.S_ISLNK(mode):
        raise SystemExit("binary cache root must be a real directory")
if not stat.S_ISDIR(path.lstat().st_mode):
    raise SystemExit("binary cache root must be a real directory")
print(path.resolve(strict=True))
PY
)"
case "$BINARY_CACHE_ROOT" in
  "$SOURCE_ROOT"|"$SOURCE_ROOT"/*)
    echo "abi-staging-prepare-runtime.sh: binary cache root must be outside the exact source tree" >&2
    exit 2
    ;;
esac
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
if [ ! -f "$SOURCE_ROOT/flake.lock" ] || [ -L "$SOURCE_ROOT/flake.lock" ]; then
  echo "abi-staging-prepare-runtime.sh: exact source dev-shell lock is unavailable" >&2
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
CANDIDATE_ENV_ROOT="$OUT/.candidate-environment"
CANDIDATE_HOME="$CANDIDATE_ENV_ROOT/home"
CANDIDATE_TMP=""

cleanup_candidate_environment() {
  if [ -n "${CANDIDATE_ENV_ROOT:-}" ] && \
     [ "$CANDIDATE_ENV_ROOT" = "$OUT/.candidate-environment" ]; then
    rm -rf -- "$CANDIDATE_ENV_ROOT"
  fi
  case "${CANDIDATE_TMP:-}" in
    /tmp/kandelo-abi-runtime.*|/private/tmp/kandelo-abi-runtime.*)
      rm -rf -- "$CANDIDATE_TMP"
      ;;
  esac
}
trap cleanup_candidate_environment EXIT

# WHY: Nix and tsx append Unix-domain socket components to TMPDIR. Linux caps
# that complete path at 108 bytes, so an artifact-root-relative directory can
# fail before any candidate build runs. Keep only transient IPC state in one
# private, bounded path; HOME and every durable artifact remain under OUT.
CANDIDATE_TMP="$(mktemp -d /tmp/kandelo-abi-runtime.XXXXXX)"
CANDIDATE_TMP="$(cd "$CANDIDATE_TMP" && pwd -P)"
case "$CANDIDATE_TMP" in
  /tmp/kandelo-abi-runtime.*|/private/tmp/kandelo-abi-runtime.*) ;;
  *)
    echo "abi-staging-prepare-runtime.sh: temporary directory is outside the bounded private namespace" >&2
    exit 1
    ;;
esac
if [ "${#CANDIDATE_TMP}" -gt 63 ]; then
  echo "abi-staging-prepare-runtime.sh: temporary directory is too long for runtime IPC" >&2
  exit 1
fi
mkdir -p "$CANDIDATE_HOME"
chmod 0700 "$CANDIDATE_ENV_ROOT" "$CANDIDATE_HOME" "$CANDIDATE_TMP"

TESTING="${KANDELO_ABI_STAGING_TESTING:-0}"
TEST_BUILDER="${KANDELO_ABI_STAGING_RUNTIME_BUILDER:-}"
TEST_TOOLCHAIN_BUILDER="${KANDELO_ABI_STAGING_TOOLCHAIN_BUILDER:-}"
if [ "$TESTING" != 0 ] && [ "$TESTING" != 1 ]; then
  echo "abi-staging-prepare-runtime.sh: invalid test mode" >&2
  exit 2
fi
if [ -n "$TEST_BUILDER" ] && { [ "$TESTING" != 1 ] || [ "${GITHUB_ACTIONS:-}" = true ]; }; then
  echo "abi-staging-prepare-runtime.sh: runtime builder replacement is local-test-only" >&2
  exit 2
fi
if [ -n "$TEST_TOOLCHAIN_BUILDER" ] &&
   { [ "$TESTING" != 1 ] || [ "${GITHUB_ACTIONS:-}" = true ]; }; then
  echo "abi-staging-prepare-runtime.sh: toolchain builder replacement is local-test-only" >&2
  exit 2
fi

run_without_credentials() {
  local with_exact_source_root=0
  if [ "${1:-}" = "--with-exact-source-root" ]; then
    with_exact_source_root=1
    shift
  fi
  local candidate_path="$KANDELO_DEV_SHELL_TOOL_PATH"
  if [ "$TESTING" = 1 ]; then
    # The fake local fixture uses platform mkdir/cp; production commands enter
    # the exact source's declared Nix shell before executing candidate code.
    candidate_path="$candidate_path:/usr/bin:/bin"
  fi
  local -a clean_environment=(
    "HOME=$CANDIDATE_HOME"
    "TMPDIR=$CANDIDATE_TMP"
    "PATH=$candidate_path"
    "KANDELO_DEV_SHELL_TOOL_PATH=$KANDELO_DEV_SHELL_TOOL_PATH"
    "WASM_POSIX_BINARY_CACHE_ROOT=$BINARY_CACHE_ROOT"
  )
  if [ "$with_exact_source_root" = 1 ]; then
    clean_environment+=(
      "KANDELO_ABI_STAGING_EXACT_SOURCE_ROOT=$SOURCE_ROOT"
    )
  fi
  local safe_name
  for safe_name in \
    CI LANG LC_ALL LC_CTYPE LOGNAME NO_COLOR SOURCE_DATE_EPOCH TERM TZ USER \
    SSL_CERT_FILE NIX_SSL_CERT_FILE GIT_SSL_CAINFO; do
    if [ -n "${!safe_name:-}" ]; then
      clean_environment+=("$safe_name=${!safe_name}")
    fi
  done
  if [ "$TESTING" = 1 ]; then
    for safe_name in \
      FAKE_RUNTIME_EMPTY_DIRECTORY FAKE_RUNTIME_EMPTY_FILE \
      FAKE_RUNTIME_HOME_MARKER \
      FAKE_RUNTIME_STARTED_MARKER FAKE_RUNTIME_SYMLINK \
      FAKE_TOOLCHAIN_STARTED_MARKER; do
      if [ -n "${!safe_name:-}" ]; then
        clean_environment+=("$safe_name=${!safe_name}")
      fi
    done
  fi
  env -i "${clean_environment[@]}" "$@"
}

run_in_exact_source_dev_shell() {
  local nix_bin="$KANDELO_NIX_BIN"
  if [[ "$nix_bin" != /* ]] || [ ! -x "$nix_bin" ]; then
    echo "abi-staging-prepare-runtime.sh: Nix is unavailable for the exact source dev shell" >&2
    exit 1
  fi
  (
    cd "$SOURCE_ROOT"
    run_without_credentials \
      "$nix_bin" develop "path:$SOURCE_ROOT" \
        --ignore-environment \
        --keep HOME \
        --keep TMPDIR \
        --keep CI \
        --keep LANG \
        --keep LC_ALL \
        --keep LC_CTYPE \
        --keep LOGNAME \
        --keep NO_COLOR \
        --keep SOURCE_DATE_EPOCH \
        --keep TERM \
        --keep TZ \
        --keep USER \
        --keep WASM_POSIX_BINARY_CACHE_ROOT \
        --accept-flake-config \
        --command "$@"
  )
}

TOOLCHAIN_ROOT="$RUNTIME_ROOT/toolchain"
if [ -n "$TEST_TOOLCHAIN_BUILDER" ]; then
  if [ ! -f "$TEST_TOOLCHAIN_BUILDER" ] || [ -L "$TEST_TOOLCHAIN_BUILDER" ] ||
     [ ! -x "$TEST_TOOLCHAIN_BUILDER" ]; then
    echo "abi-staging-prepare-runtime.sh: test toolchain builder is unavailable" >&2
    exit 2
  fi
  run_without_credentials \
    "$TEST_TOOLCHAIN_BUILDER" "$SOURCE_ROOT" "$TOOLCHAIN_ROOT"
else
  TOOLCHAIN_BUILDER="$REPO_ROOT/scripts/abi-staging-build-toolchain.sh"
  if [ ! -f "$TOOLCHAIN_BUILDER" ] || [ -L "$TOOLCHAIN_BUILDER" ] ||
     [ ! -x "$TOOLCHAIN_BUILDER" ]; then
    echo "abi-staging-prepare-runtime.sh: protected toolchain builder is unavailable" >&2
    exit 1
  fi
  run_in_exact_source_dev_shell \
    "$TOOLCHAIN_BUILDER" --source-root "$SOURCE_ROOT" --out "$TOOLCHAIN_ROOT"
fi

for required_toolchain_file in \
  "$TOOLCHAIN_ROOT/wasm32-sysroot/lib/libc.a" \
  "$TOOLCHAIN_ROOT/wasm64-sysroot/lib/libc.a" \
  "$TOOLCHAIN_ROOT/clang-resource-headers/include/stddef.h"; do
  if [ ! -s "$required_toolchain_file" ] || [ -L "$required_toolchain_file" ]; then
    echo "abi-staging-prepare-runtime.sh: exact toolchain output is unavailable: $required_toolchain_file" >&2
    exit 1
  fi
done

snapshot_toolchain() {
  python3 - "$TOOLCHAIN_ROOT" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1])
inventory: list[dict[str, object]] = []
entry_count = 0
directory_count = 0
total = 0
for directory, directories, files in os.walk(root, followlinks=False):
    directories.sort()
    files.sort()
    relative_directory = Path(directory).relative_to(root)
    if len(relative_directory.parts) > 64:
        raise SystemExit("toolchain snapshot exceeds its directory depth bound")
    for name in directories:
        entry_count += 1
        directory_count += 1
        path = Path(directory, name)
        if entry_count > 65536 or directory_count > 4096:
            raise SystemExit("toolchain snapshot exceeds its entry bound")
        if stat.S_ISLNK(path.lstat().st_mode):
            raise SystemExit(f"toolchain snapshot contains a symbolic link: {path}")
    for name in files:
        entry_count += 1
        path = Path(directory, name)
        if entry_count > 65536:
            raise SystemExit("toolchain snapshot exceeds its entry bound")
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
            raise SystemExit(f"toolchain snapshot contains a nonregular file: {path}")
        size = path.stat().st_size
        if size > 256 * 1024 * 1024 or size > 1024 * 1024 * 1024 - total:
            raise SystemExit("toolchain snapshot exceeds its byte bound")
        total += size
        hasher = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(64 * 1024):
                hasher.update(chunk)
        inventory.append({
            "bytes": size,
            "path": path.relative_to(root).as_posix(),
            "sha256": hasher.hexdigest(),
        })
inventory.sort(key=lambda item: item["path"])
if not inventory:
    raise SystemExit("toolchain snapshot is empty")
print(json.dumps(inventory, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
PY
}

TOOLCHAIN_INVENTORY_BEFORE="$(snapshot_toolchain)"

if [ -n "$TEST_BUILDER" ]; then
  if [ ! -f "$TEST_BUILDER" ] || [ -L "$TEST_BUILDER" ] || [ ! -x "$TEST_BUILDER" ]; then
    echo "abi-staging-prepare-runtime.sh: test runtime builder is unavailable" >&2
    exit 2
  fi
  run_without_credentials "$TEST_BUILDER" "$SOURCE_ROOT" "$RUNTIME_ROOT"
else
  for source_sysroot in "$SOURCE_ROOT/sysroot" "$SOURCE_ROOT/sysroot64"; do
    if [ -e "$source_sysroot" ] || [ -L "$source_sysroot" ]; then
      echo "abi-staging-prepare-runtime.sh: exact source contains an ambient build sysroot: $source_sysroot" >&2
      exit 1
    fi
  done
  # `build.sh` is the normal candidate runtime path. Give it private copies so
  # its ordinary program/package steps may add resolved libraries without
  # mutating the pristine toolchain artifact consumed by product jobs.
  cp -R "$TOOLCHAIN_ROOT/wasm32-sysroot" "$SOURCE_ROOT/sysroot"
  cp -R "$TOOLCHAIN_ROOT/wasm64-sysroot" "$SOURCE_ROOT/sysroot64"
  run_in_exact_source_dev_shell bash -c '
    set -euo pipefail
    bash build.sh
    npm --prefix apps/browser-demos install --prefer-offline
    npm --prefix apps/browser-demos run build -- \
      --mode abi-staging-browser-evidence
  '

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

  PROTECTED_VITE="$REPO_ROOT/apps/browser-demos/node_modules/.bin/vite"
  if [ ! -x "$PROTECTED_VITE" ]; then
    echo "abi-staging-prepare-runtime.sh: protected browser host bundler is unavailable" >&2
    exit 1
  fi
  run_without_credentials --with-exact-source-root \
    "$PROTECTED_VITE" build \
      --config "$REPO_ROOT/apps/browser-demos/abi-staging-browser-host.config.ts" \
      --outDir "$RUNTIME_ROOT/browser/dist/abi-staging" \
      --emptyOutDir
  run_without_credentials \
    "$PROTECTED_VITE" build \
      --config "$REPO_ROOT/apps/browser-demos/abi-staging-browser-harness.config.ts" \
      --outDir "$RUNTIME_ROOT/browser/dist/abi-staging-harness" \
      --emptyOutDir
fi

TOOLCHAIN_INVENTORY_AFTER="$(snapshot_toolchain)"
if [ "$TOOLCHAIN_INVENTORY_AFTER" != "$TOOLCHAIN_INVENTORY_BEFORE" ]; then
  echo "abi-staging-prepare-runtime.sh: exact toolchain changed during runtime build" >&2
  exit 1
fi

# The tap resolves every build/toolchain claim against the exact head's
# declared dev shell. Carry that lock as an ordinary inventory-bound artifact
# so protected consumers never infer toolchain identity from ambient tools.
cp "$SOURCE_ROOT/flake.lock" "$RUNTIME_ROOT/flake.lock"

# Keep the downloaded host bundle self-describing when it is extracted outside
# the repository. Protected evidence imports this exact ESM bundle; it must not
# inherit module semantics from an ambient parent package.json.
printf '%s\n' '{"type":"module"}' >"$RUNTIME_ROOT/host/package.json"
for node_entry in \
  "$RUNTIME_ROOT/host/dist/index.js" \
  "$RUNTIME_ROOT/host/dist/node-kernel-worker-entry.js"; do
  if [ ! -f "$node_entry" ] || [ -L "$node_entry" ]; then
    echo "abi-staging-prepare-runtime.sh: exact Node runtime entry is unavailable: $node_entry" >&2
    exit 1
  fi
done

if [ "$ACTUAL_COMMIT" != "$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD)" ] || \
   [ "$ACTUAL_TREE" != "$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD^{tree})" ] || \
   [ -n "$(git -C "$SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "abi-staging-prepare-runtime.sh: exact source changed during runtime build" >&2
  exit 1
fi

cleanup_candidate_environment
trap - EXIT

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
entry_count = 0
directory_count = 0
for directory, directories, files in os.walk(runtime, followlinks=False):
    directories.sort()
    files.sort()
    relative_directory = Path(directory).relative_to(runtime)
    if len(relative_directory.parts) > 64:
        raise SystemExit("runtime inventory exceeds its directory depth bound")
    if relative_directory != Path() and not directories and not files:
        raise SystemExit(f"runtime inventory contains an empty directory: {directory}")
    for name in directories:
        entry_count += 1
        directory_count += 1
        if entry_count > 65536:
            raise SystemExit("runtime inventory exceeds its total entry bound")
        if directory_count > 4096:
            raise SystemExit("runtime inventory exceeds its directory bound")
        path = Path(directory, name)
        if stat.S_ISLNK(path.lstat().st_mode):
            raise SystemExit(f"runtime inventory contains a symbolic link: {path}")
    for name in files:
        entry_count += 1
        if entry_count > 65536:
            raise SystemExit("runtime inventory exceeds its total entry bound")
        path = Path(directory, name)
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise SystemExit(f"runtime inventory contains a symbolic link: {path}")
        if not stat.S_ISREG(mode):
            raise SystemExit(f"runtime inventory contains a nonregular file: {path}")
        relative = path.relative_to(runtime).as_posix()
        size = path.stat().st_size
        if relative in {
            "host/dist/index.js",
            "host/dist/node-kernel-worker-entry.js",
        }:
            file_limit = 64 * 1024 * 1024
        elif relative == "kernel.wasm":
            file_limit = 512 * 1024 * 1024
        else:
            file_limit = 256 * 1024 * 1024
        if size == 0 and not relative.startswith("toolchain/"):
            raise SystemExit(f"runtime inventory contains an empty file: {relative}")
        if size > file_limit:
            raise SystemExit(f"runtime inventory file exceeds its bound: {relative}")
        if size > 1024 * 1024 * 1024 - total:
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
browser_host = entry("browser/dist/abi-staging/browser-host.js")
browser_harness = entry("browser/dist/abi-staging-harness/index.html")
host_sha256, host_bytes = subset("host/")
browser_sha256, browser_bytes = subset("browser/")
browser_kernel_assets = [
    item for item in inventory
    if str(item["path"]).startswith("browser/dist/")
    and str(item["path"]).endswith(".wasm")
    and item["sha256"] == kernel["sha256"]
    and item["bytes"] == kernel["bytes"]
]
if len(browser_kernel_assets) != 1:
    raise SystemExit("runtime browser dist lacks one exact emitted kernel Wasm asset")
browser_kernel = browser_kernel_assets[0]
bundle = {
    "browser": {
        "bundle_sha256": browser_sha256,
        "bytes": browser_bytes,
        "harness_entry_bytes": browser_harness["bytes"],
        "harness_entry_path": browser_harness["path"],
        "harness_entry_sha256": browser_harness["sha256"],
        "host_entry_bytes": browser_host["bytes"],
        "host_entry_path": browser_host["path"],
        "host_entry_sha256": browser_host["sha256"],
        "kernel_asset_path": browser_kernel["path"],
        "kernel_asset_sha256": browser_kernel["sha256"],
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
