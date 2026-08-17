#!/usr/bin/env bash
# Focused contract tests for exact-head, uncredentialed runtime preparation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PREPARER="$REPO_ROOT/scripts/abi-staging-prepare-runtime.sh"
TMP_ROOT="$(mktemp -d)"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-abi-staging-prepare-runtime.sh: $*" >&2
  exit 1
}

: "${KANDELO_DEV_SHELL_TOOL_PATH:?test must run through scripts/dev-shell.sh}"
[ -x "$PREPARER" ] || fail "runtime preparer is absent"
if grep -Fq 'production runtime source must be this exact checkout' "$PREPARER"; then
  fail "protected runtime tooling requires the candidate source to own the script"
fi
if ! grep -Fq 'run_without_credentials --with-exact-source-root \' "$PREPARER" ||
   grep -Fq 'run_without_credentials env \' "$PREPARER"; then
  fail "protected Vite must receive its exact source root without a second PATH launcher"
fi
grep -Fq -- '--mode abi-staging-browser-evidence' "$PREPARER" ||
  fail "runtime preparation does not select the closed browser evidence build"

SOURCE="$TMP_ROOT/source"
mkdir -p "$SOURCE/abi" "$SOURCE/host/src/generated" "$SOURCE/host/src"
printf '%s\n' '{"abi":8}' >"$SOURCE/abi/snapshot.json"
printf '%s\n' 'export const ABI_VERSION = 8 as const;' \
  >"$SOURCE/host/src/generated/abi.ts"
printf '%s\n' "export type WorkerMessage = { kind: 'fixture' };" \
  >"$SOURCE/host/src/worker-protocol.ts"
printf '%s\n' '{"nodes":{},"root":"root","version":7}' >"$SOURCE/flake.lock"
git -C "$SOURCE" init -q
git -C "$SOURCE" add .
git -C "$SOURCE" -c user.name=Fixture -c user.email=fixture.invalid \
  commit -qm 'runtime fixture'
SOURCE_COMMIT="$(git -C "$SOURCE" rev-parse HEAD)"
SOURCE_TREE="$(git -C "$SOURCE" rev-parse HEAD^{tree})"
SNAPSHOT_SHA256="$(sha256sum "$SOURCE/abi/snapshot.json" | awk '{print $1}')"
POLICY_SHA256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
CACHE_ROOT="$TMP_ROOT/exact-package-cache"
mkdir -m 0700 "$CACHE_ROOT"

FAKE_BUILDER="$TMP_ROOT/fake-runtime-builder"
cat >"$FAKE_BUILDER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source_root="$1"
artifact_root="$2"
[ -s "$artifact_root/toolchain/wasm32-sysroot/lib/libc.a" ] || exit 93
[ -s "$artifact_root/toolchain/wasm64-sysroot/lib/libc.a" ] || exit 94
if [ -n "${FAKE_RUNTIME_STARTED_MARKER:-}" ]; then
  printf 'started\n' >"$FAKE_RUNTIME_STARTED_MARKER"
fi
if [[ "${FAKE_RUNTIME_STARTED_MARKER:-}" == */mutate-toolchain.started ]]; then
  printf 'candidate-mutated toolchain\n' \
    >"$artifact_root/toolchain/wasm32-sysroot/lib/libc.a"
fi
for secret in GITHUB_TOKEN GH_TOKEN GHCR_PAT ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  ACTIONS_RUNTIME_TOKEN; do
  [ -z "${!secret:-}" ] || exit 90
done
[ -z "${SUPER_SECRET:-}" ] || exit 91
if [ -n "${FAKE_RUNTIME_HOME_MARKER:-}" ]; then
  printf '%s\n' "$HOME" >"$FAKE_RUNTIME_HOME_MARKER"
  python3 - "${FAKE_RUNTIME_HOME_MARKER}.tmp" <<'PY'
from pathlib import Path
import os
import stat
import sys

temporary = Path(os.environ["TMPDIR"])
mode = stat.S_IMODE(os.lstat(temporary).st_mode)
Path(sys.argv[1]).write_text(f"{temporary}\n{mode:o}\n")
PY
fi
printf '%s\n' "${WASM_POSIX_BINARY_CACHE_ROOT:-}" \
  >"${WASM_POSIX_BINARY_CACHE_ROOT:?}/runtime-cache-root.observed"
mkdir -p \
  "$artifact_root/host/dist" \
  "$artifact_root/browser/dist/abi-staging" \
  "$artifact_root/browser/dist/abi-staging-harness" \
  "$artifact_root/browser/dist/assets"
if [ "${FAKE_RUNTIME_EMPTY_DIRECTORY:-0}" = 1 ]; then
  mkdir -p "$artifact_root/unrepresented-empty-directory"
fi
if [ "${FAKE_RUNTIME_EMPTY_FILE:-0}" = 1 ]; then
  : >"$artifact_root/unrepresented-empty-file"
fi
python3 - "$artifact_root/kernel.wasm" <<'PY'
from pathlib import Path
import sys
body = bytearray(b"\0asm\x01\0\0\0\x01\x05\x01\x60\0\x01\x7f\x03\x02\x01\0\x07\x11\x01\x0d__abi_version\0\0\x0a\x06\x01\x04\0\x41")
body.extend((8, 0x0b))
Path(sys.argv[1]).write_bytes(body)
PY
cp "$artifact_root/kernel.wasm" "$artifact_root/browser/dist/assets/kernel.wasm"
cp "$source_root/host/src/generated/abi.ts" \
  "$artifact_root/host/generated-abi.ts"
cp "$source_root/host/src/worker-protocol.ts" \
  "$artifact_root/host/worker-protocol.ts"
printf 'host bundle\n' >"$artifact_root/host/dist/index.js"
printf 'node worker bundle\n' >"$artifact_root/host/dist/node-kernel-worker-entry.js"
printf 'browser bundle\n' >"$artifact_root/browser/dist/index.js"
printf 'export class BrowserKernel {}\n' \
  >"$artifact_root/browser/dist/abi-staging/browser-host.js"
printf '<!doctype html><title>protected evidence harness</title>\n' \
  >"$artifact_root/browser/dist/abi-staging-harness/index.html"
printf 'service worker\n' >"$artifact_root/browser/dist/service-worker.js"
if [ "${FAKE_RUNTIME_SYMLINK:-0}" = 1 ]; then
  rm "$artifact_root/browser/dist/service-worker.js"
  ln -s index.js "$artifact_root/browser/dist/service-worker.js"
fi
EOF
chmod 0755 "$FAKE_BUILDER"

FAKE_TOOLCHAIN_BUILDER="$TMP_ROOT/fake-toolchain-builder"
cat >"$FAKE_TOOLCHAIN_BUILDER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source_root="$1"
toolchain_root="$2"
[ -d "$source_root" ]
for secret in GITHUB_TOKEN GH_TOKEN GHCR_PAT ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  ACTIONS_RUNTIME_TOKEN SUPER_SECRET; do
  [ -z "${!secret:-}" ] || exit 92
done
if [ -n "${FAKE_TOOLCHAIN_STARTED_MARKER:-}" ]; then
  printf 'started\n' >"$FAKE_TOOLCHAIN_STARTED_MARKER"
fi
mkdir -p \
  "$toolchain_root/wasm32-sysroot/include/bits" \
  "$toolchain_root/wasm32-sysroot/lib" \
  "$toolchain_root/wasm64-sysroot/lib" \
  "$toolchain_root/clang-resource-headers/include"
printf 'wasm32 libc archive\n' >"$toolchain_root/wasm32-sysroot/lib/libc.a"
# musl deliberately installs several empty architecture headers. They are
# compiler inputs whose existence matters even though their byte length is 0.
: >"$toolchain_root/wasm32-sysroot/include/bits/ioctl_fix.h"
printf 'wasm64 libc archive\n' >"$toolchain_root/wasm64-sysroot/lib/libc.a"
printf 'clang stddef fixture\n' \
  >"$toolchain_root/clang-resource-headers/include/stddef.h"
EOF
chmod 0755 "$FAKE_TOOLCHAIN_BUILDER"

run_preparer_with_cache() {
  local cache_root="$1"
  local out="$2"
  env \
    KANDELO_ABI_STAGING_TESTING=1 \
    KANDELO_ABI_STAGING_RUNTIME_BUILDER="$FAKE_BUILDER" \
    KANDELO_ABI_STAGING_TOOLCHAIN_BUILDER="$FAKE_TOOLCHAIN_BUILDER" \
    "$PREPARER" \
      --source-root "$SOURCE" \
      --source-repository example/kandelo \
      --source-commit "$SOURCE_COMMIT" \
      --source-tree "$SOURCE_TREE" \
      --target-abi 8 \
      --snapshot-sha256 "$SNAPSHOT_SHA256" \
      --build-policy-sha256 "$POLICY_SHA256" \
      --binary-cache-root "$cache_root" \
      --out "$out"
}

run_preparer() {
  run_preparer_with_cache "$CACHE_ROOT" "$1"
}

OUT="$TMP_ROOT/out"
FAKE_TOOLCHAIN_STARTED_MARKER="$TMP_ROOT/toolchain.started" run_preparer "$OUT"
[ "$(cat "$TMP_ROOT/toolchain.started")" = started ] ||
  fail "runtime preparation did not invoke its isolated toolchain builder"
observed_cache_root="$(cat "$CACHE_ROOT/runtime-cache-root.observed")"
[ "$(realpath "$observed_cache_root")" = "$(realpath "$CACHE_ROOT")" ] ||
  fail "runtime preparation dropped or substituted the exact package cache root"

CACHE_SYMLINK_TARGET="$TMP_ROOT/cache-symlink-target"
CACHE_SYMLINK="$TMP_ROOT/cache-symlink"
mkdir -m 0700 "$CACHE_SYMLINK_TARGET"
ln -s "$CACHE_SYMLINK_TARGET" "$CACHE_SYMLINK"
if FAKE_TOOLCHAIN_STARTED_MARKER="$TMP_ROOT/cache-symlink.started" \
    run_preparer_with_cache "$CACHE_SYMLINK" "$TMP_ROOT/cache-symlink-out" \
      >"$TMP_ROOT/cache-symlink.out" 2>&1; then
  fail "runtime preparation accepted a symlinked package cache root"
fi
[ ! -e "$TMP_ROOT/cache-symlink.started" ] ||
  fail "runtime preparation executed before rejecting a symlinked package cache root"
grep -F 'binary cache root must be a real directory' \
  "$TMP_ROOT/cache-symlink.out" >/dev/null ||
  fail "symlinked package-cache rejection was not explicit"

if FAKE_TOOLCHAIN_STARTED_MARKER="$TMP_ROOT/cache-relative.started" \
    run_preparer_with_cache "relative-package-cache" "$TMP_ROOT/cache-relative-out" \
      >"$TMP_ROOT/cache-relative.out" 2>&1; then
  fail "runtime preparation accepted a relative package cache root"
fi
[ ! -e "$TMP_ROOT/cache-relative.started" ] ||
  fail "runtime preparation executed before rejecting a relative package cache root"
grep -F 'binary cache root must be absolute' \
  "$TMP_ROOT/cache-relative.out" >/dev/null ||
  fail "relative package-cache rejection was not explicit"

mkdir -m 0700 "$SOURCE/cache-inside-source"
if FAKE_TOOLCHAIN_STARTED_MARKER="$TMP_ROOT/cache-inside.started" \
    run_preparer_with_cache "$SOURCE/cache-inside-source" \
      "$TMP_ROOT/cache-inside-out" >"$TMP_ROOT/cache-inside.out" 2>&1; then
  fail "runtime preparation accepted a package cache inside the exact source"
fi
[ ! -e "$TMP_ROOT/cache-inside.started" ] ||
  fail "runtime preparation executed before rejecting an in-source package cache"
grep -F 'binary cache root must be outside the exact source tree' \
  "$TMP_ROOT/cache-inside.out" >/dev/null ||
  fail "in-source package-cache rejection was not explicit"
rmdir "$SOURCE/cache-inside-source"
[ -s "$OUT/runtime-bundle.json" ] || fail "runtime bundle was not emitted"
[ -s "$OUT/runtime/kernel.wasm" ] || fail "kernel artifact was not emitted"
[ "$(jq -r '.source.commit' "$OUT/runtime-bundle.json")" = "$SOURCE_COMMIT" ] ||
  fail "runtime bundle did not bind the exact source head"
[ "$(jq -r '.target_abi.version' "$OUT/runtime-bundle.json")" = 8 ] ||
  fail "runtime bundle did not bind the target ABI"
[ "$(jq -r '.inventory | length' "$OUT/runtime-bundle.json")" = 16 ] ||
  fail "runtime bundle inventory is incomplete"
[ "$(jq -r '.inventory[] | select(.path == "flake.lock") | .sha256' \
    "$OUT/runtime-bundle.json")" = \
  "$(sha256sum "$SOURCE/flake.lock" | awk '{print $1}')" ] ||
  fail "runtime bundle did not bind the exact dev-shell lock"
cmp -s "$SOURCE/flake.lock" "$OUT/runtime/flake.lock" ||
  fail "runtime bundle did not carry the exact dev-shell lock"
[ "$(cat "$OUT/runtime/host/package.json")" = '{"type":"module"}' ] ||
  fail "runtime bundle lacks protected Node module identity"
[ -s "$OUT/runtime/host/dist/node-kernel-worker-entry.js" ] ||
  fail "runtime bundle lacks the exact Node worker entry"
[ "$(jq -r '.browser.kernel_asset_path' "$OUT/runtime-bundle.json")" = \
    "browser/dist/assets/kernel.wasm" ] ||
  fail "runtime bundle did not bind the emitted browser kernel asset"
[ "$(jq -r '.browser.host_entry_path' "$OUT/runtime-bundle.json")" = \
    "browser/dist/abi-staging/browser-host.js" ] ||
  fail "runtime bundle did not bind the exact browser host entry"
[ "$(jq -r '.browser.harness_entry_path' "$OUT/runtime-bundle.json")" = \
    "browser/dist/abi-staging-harness/index.html" ] ||
  fail "runtime bundle did not bind the protected browser evidence harness"
[ -s "$OUT/runtime/toolchain/wasm32-sysroot/lib/libc.a" ] ||
  fail "runtime bundle lacks its exact wasm32 sysroot"
[ -s "$OUT/runtime/toolchain/wasm64-sysroot/lib/libc.a" ] ||
  fail "runtime bundle lacks its exact wasm64 sysroot"
[ -s "$OUT/runtime/toolchain/clang-resource-headers/include/stddef.h" ] ||
  fail "runtime bundle lacks its exact Clang resource headers"
[ -f "$OUT/runtime/toolchain/wasm32-sysroot/include/bits/ioctl_fix.h" ] ||
  fail "runtime bundle dropped an intentional empty musl header"

if FAKE_RUNTIME_STARTED_MARKER="$TMP_ROOT/mutate-toolchain.started" \
    run_preparer "$TMP_ROOT/mutated-toolchain" \
      >"$TMP_ROOT/mutated-toolchain.out" 2>&1; then
  fail "runtime preparation accepted candidate-mutated toolchain bytes"
fi
grep -F 'toolchain changed during runtime build' \
  "$TMP_ROOT/mutated-toolchain.out" >/dev/null ||
  fail "candidate toolchain mutation rejection was not explicit"

PRIVATE_ENV_OUT="$TMP_ROOT/private-environment"
SUPER_SECRET=must-not-cross \
  FAKE_RUNTIME_HOME_MARKER="$TMP_ROOT/candidate-home" \
  run_preparer "$PRIVATE_ENV_OUT"
[ -s "$TMP_ROOT/candidate-home" ] || fail "candidate builder did not report its HOME"
[ "$(cat "$TMP_ROOT/candidate-home")" != "$HOME" ] ||
  fail "candidate runtime inherited the ambient HOME"
PRIVATE_ENV_OUT_REAL="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$PRIVATE_ENV_OUT")"
case "$(cat "$TMP_ROOT/candidate-home")" in
  "$PRIVATE_ENV_OUT_REAL"/.candidate-environment/home) ;;
  *) fail "candidate runtime did not receive its private HOME" ;;
esac
candidate_tmp=$(sed -n '1p' "$TMP_ROOT/candidate-home.tmp")
[ "$(sed -n '2p' "$TMP_ROOT/candidate-home.tmp")" = 700 ] ||
  fail "candidate runtime temporary directory was not private"
case "$candidate_tmp" in
  /tmp/kandelo-abi-runtime.*|/private/tmp/kandelo-abi-runtime.*) ;;
  *) fail "candidate runtime did not receive a bounded short temporary path" ;;
esac
# Linux limits Unix-domain socket paths to 108 bytes. Nix and tsx append this
# representative suffix before opening the IPC listener used by the runtime
# builder, so retain one byte for the terminating NUL.
tsx_socket_suffix='/nix-shell.XXXXXX/tsx-1001/12345.pipe'
[ "$(( ${#candidate_tmp} + ${#tsx_socket_suffix} ))" -lt 108 ] ||
  fail "candidate runtime temporary path cannot host the tsx IPC socket"
[ ! -e "$candidate_tmp" ] ||
  fail "candidate runtime temporary directory survived preparation"

printf 'ambient\n' >"$SOURCE/ambient-untracked-input"
if FAKE_RUNTIME_STARTED_MARKER="$TMP_ROOT/untracked.started" \
    run_preparer "$TMP_ROOT/untracked" >"$TMP_ROOT/untracked.out" 2>&1; then
  fail "runtime preparation accepted an untracked source input"
fi
[ ! -e "$TMP_ROOT/untracked.started" ] ||
  fail "runtime preparation executed a builder before rejecting untracked input"
grep -F 'untracked' "$TMP_ROOT/untracked.out" >/dev/null ||
  fail "untracked-source rejection was not explicit"
rm "$SOURCE/ambient-untracked-input"

if FAKE_RUNTIME_STARTED_MARKER="$TMP_ROOT/inside-source.started" \
    run_preparer "$SOURCE/runtime-output" >"$TMP_ROOT/inside-source.out" 2>&1; then
  fail "runtime preparation accepted output inside the exact source tree"
fi
[ ! -e "$TMP_ROOT/inside-source.started" ] ||
  fail "runtime preparation executed before rejecting output inside the source tree"
grep -F 'outside the exact source' "$TMP_ROOT/inside-source.out" >/dev/null ||
  fail "inside-source output rejection was not explicit"

if env \
    GITHUB_TOKEN=ghp_fixture_secret \
    KANDELO_ABI_STAGING_TESTING=1 \
    KANDELO_ABI_STAGING_RUNTIME_BUILDER="$FAKE_BUILDER" \
    "$PREPARER" \
      --source-root "$SOURCE" \
      --source-repository example/kandelo \
      --source-commit "$SOURCE_COMMIT" \
      --source-tree "$SOURCE_TREE" \
      --target-abi 8 \
      --snapshot-sha256 "$SNAPSHOT_SHA256" \
      --build-policy-sha256 "$POLICY_SHA256" \
      --binary-cache-root "$CACHE_ROOT" \
      --out "$TMP_ROOT/credentialed" >"$TMP_ROOT/credentialed.out" 2>&1; then
  fail "runtime preparation accepted a write credential"
fi
grep -F 'credential' "$TMP_ROOT/credentialed.out" >/dev/null ||
  fail "credential rejection was not explicit"

if env \
    ACTIONS_RUNTIME_TOKEN=artifact_service_fixture_secret \
    KANDELO_ABI_STAGING_TESTING=1 \
    KANDELO_ABI_STAGING_RUNTIME_BUILDER="$FAKE_BUILDER" \
    "$PREPARER" \
      --source-root "$SOURCE" \
      --source-repository example/kandelo \
      --source-commit "$SOURCE_COMMIT" \
      --source-tree "$SOURCE_TREE" \
      --target-abi 8 \
      --snapshot-sha256 "$SNAPSHOT_SHA256" \
      --build-policy-sha256 "$POLICY_SHA256" \
      --binary-cache-root "$CACHE_ROOT" \
      --out "$TMP_ROOT/runtime-token" >"$TMP_ROOT/runtime-token.out" 2>&1; then
  fail "runtime preparation accepted the Actions runtime credential"
fi
grep -F 'ACTIONS_RUNTIME_TOKEN' "$TMP_ROOT/runtime-token.out" >/dev/null ||
  fail "Actions runtime credential rejection was not explicit"

if env \
    KANDELO_ABI_STAGING_TESTING=1 \
    KANDELO_ABI_STAGING_RUNTIME_BUILDER="$FAKE_BUILDER" \
    "$PREPARER" \
      --source-root "$SOURCE" \
      --source-repository example/kandelo \
      --source-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
      --source-tree "$SOURCE_TREE" \
      --target-abi 8 \
      --snapshot-sha256 "$SNAPSHOT_SHA256" \
      --build-policy-sha256 "$POLICY_SHA256" \
      --binary-cache-root "$CACHE_ROOT" \
      --out "$TMP_ROOT/wrong-head" >"$TMP_ROOT/wrong-head.out" 2>&1; then
  fail "runtime preparation accepted a synthetic or different head"
fi
grep -F 'exact source' "$TMP_ROOT/wrong-head.out" >/dev/null ||
  fail "wrong-head rejection was not explicit"

if FAKE_RUNTIME_SYMLINK=1 \
    FAKE_RUNTIME_HOME_MARKER="$TMP_ROOT/symlink-home" \
    run_preparer "$TMP_ROOT/symlink" \
    >"$TMP_ROOT/symlink.out" 2>&1; then
  fail "runtime preparation accepted a symlinked artifact"
fi
grep -F 'symbolic link' "$TMP_ROOT/symlink.out" >/dev/null ||
  fail "symlink rejection was not explicit"
symlink_tmp=$(sed -n '1p' "$TMP_ROOT/symlink-home.tmp")
[ ! -e "$symlink_tmp" ] ||
  fail "candidate runtime temporary directory survived failed preparation"

if FAKE_RUNTIME_EMPTY_DIRECTORY=1 run_preparer "$TMP_ROOT/empty-directory" \
    >"$TMP_ROOT/empty-directory.out" 2>&1; then
  fail "runtime preparation accepted an unrepresented empty directory"
fi
grep -F 'empty directory' "$TMP_ROOT/empty-directory.out" >/dev/null ||
  fail "empty-directory rejection was not explicit"

if FAKE_RUNTIME_EMPTY_FILE=1 run_preparer "$TMP_ROOT/empty-file" \
    >"$TMP_ROOT/empty-file.out" 2>&1; then
  fail "runtime preparation accepted an unrepresented empty file"
fi
grep -F 'empty file' "$TMP_ROOT/empty-file.out" >/dev/null ||
  fail "empty-file rejection was not explicit"

cp "$OUT/runtime-bundle.json" "$TMP_ROOT/tampered.json"
jq -cS '.source.tree = "cccccccccccccccccccccccccccccccccccccccc"' \
  "$TMP_ROOT/tampered.json" >"$TMP_ROOT/tampered.next"
mv "$TMP_ROOT/tampered.next" "$TMP_ROOT/tampered.json"
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
if cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
    abi-staging runtime-bundle validate \
      --bundle "$TMP_ROOT/tampered.json" \
      --artifact-root "$OUT/runtime" \
      --source-root "$SOURCE" \
      --repository example/kandelo \
      --commit "$SOURCE_COMMIT" \
      --tree "$SOURCE_TREE" \
      --abi 8 \
      --snapshot-sha256 "$SNAPSHOT_SHA256" \
      --build-policy-sha256 "$POLICY_SHA256" \
      >"$TMP_ROOT/tampered.out" 2>&1; then
  fail "runtime validator accepted substituted source identity"
fi
grep -F 'source differs' "$TMP_ROOT/tampered.out" >/dev/null ||
  fail "substituted source rejection was not explicit"

echo "ABI staging exact runtime preparation: PASS"
