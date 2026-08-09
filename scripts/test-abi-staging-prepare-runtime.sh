#!/usr/bin/env bash
# Focused contract tests for exact-head, uncredentialed runtime preparation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PREPARER="$REPO_ROOT/scripts/abi-staging-prepare-runtime.sh"
TMP_ROOT="$(mktemp -d)"
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

SOURCE="$TMP_ROOT/source"
mkdir -p "$SOURCE/abi" "$SOURCE/host/src/generated" "$SOURCE/host/src"
printf '%s\n' '{"abi":8}' >"$SOURCE/abi/snapshot.json"
printf '%s\n' 'export const ABI_VERSION = 8 as const;' \
  >"$SOURCE/host/src/generated/abi.ts"
printf '%s\n' "export type WorkerMessage = { kind: 'fixture' };" \
  >"$SOURCE/host/src/worker-protocol.ts"
git -C "$SOURCE" init -q
git -C "$SOURCE" add .
git -C "$SOURCE" -c user.name=Fixture -c user.email=fixture.invalid \
  commit -qm 'runtime fixture'
SOURCE_COMMIT="$(git -C "$SOURCE" rev-parse HEAD)"
SOURCE_TREE="$(git -C "$SOURCE" rev-parse HEAD^{tree})"
SNAPSHOT_SHA256="$(sha256sum "$SOURCE/abi/snapshot.json" | awk '{print $1}')"
POLICY_SHA256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

FAKE_BUILDER="$TMP_ROOT/fake-runtime-builder"
cat >"$FAKE_BUILDER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source_root="$1"
artifact_root="$2"
if [ -n "${FAKE_RUNTIME_STARTED_MARKER:-}" ]; then
  printf 'started\n' >"$FAKE_RUNTIME_STARTED_MARKER"
fi
for secret in GITHUB_TOKEN GH_TOKEN GHCR_PAT ACTIONS_ID_TOKEN_REQUEST_TOKEN; do
  [ -z "${!secret:-}" ] || exit 90
done
mkdir -p "$artifact_root/host/dist" "$artifact_root/browser/dist"
python3 - "$artifact_root/kernel.wasm" <<'PY'
from pathlib import Path
import sys
body = bytearray(b"\0asm\x01\0\0\0\x01\x05\x01\x60\0\x01\x7f\x03\x02\x01\0\x07\x11\x01\x0d__abi_version\0\0\x0a\x06\x01\x04\0\x41")
body.extend((8, 0x0b))
Path(sys.argv[1]).write_bytes(body)
PY
cp "$source_root/host/src/generated/abi.ts" \
  "$artifact_root/host/generated-abi.ts"
cp "$source_root/host/src/worker-protocol.ts" \
  "$artifact_root/host/worker-protocol.ts"
printf 'host bundle\n' >"$artifact_root/host/dist/index.js"
printf 'browser bundle\n' >"$artifact_root/browser/dist/index.js"
printf 'service worker\n' >"$artifact_root/browser/dist/service-worker.js"
if [ "${FAKE_RUNTIME_SYMLINK:-0}" = 1 ]; then
  rm "$artifact_root/browser/dist/service-worker.js"
  ln -s index.js "$artifact_root/browser/dist/service-worker.js"
fi
EOF
chmod 0755 "$FAKE_BUILDER"

run_preparer() {
  local out="$1"
  env \
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
      --out "$out"
}

OUT="$TMP_ROOT/out"
run_preparer "$OUT"
[ -s "$OUT/runtime-bundle.json" ] || fail "runtime bundle was not emitted"
[ -s "$OUT/runtime/kernel.wasm" ] || fail "kernel artifact was not emitted"
[ "$(jq -r '.source.commit' "$OUT/runtime-bundle.json")" = "$SOURCE_COMMIT" ] ||
  fail "runtime bundle did not bind the exact source head"
[ "$(jq -r '.target_abi.version' "$OUT/runtime-bundle.json")" = 8 ] ||
  fail "runtime bundle did not bind the target ABI"
[ "$(jq -r '.inventory | length' "$OUT/runtime-bundle.json")" = 6 ] ||
  fail "runtime bundle inventory is incomplete"

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
      --out "$TMP_ROOT/credentialed" >"$TMP_ROOT/credentialed.out" 2>&1; then
  fail "runtime preparation accepted a write credential"
fi
grep -F 'credential' "$TMP_ROOT/credentialed.out" >/dev/null ||
  fail "credential rejection was not explicit"

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
      --out "$TMP_ROOT/wrong-head" >"$TMP_ROOT/wrong-head.out" 2>&1; then
  fail "runtime preparation accepted a synthetic or different head"
fi
grep -F 'exact source' "$TMP_ROOT/wrong-head.out" >/dev/null ||
  fail "wrong-head rejection was not explicit"

if FAKE_RUNTIME_SYMLINK=1 run_preparer "$TMP_ROOT/symlink" \
    >"$TMP_ROOT/symlink.out" 2>&1; then
  fail "runtime preparation accepted a symlinked artifact"
fi
grep -F 'symbolic link' "$TMP_ROOT/symlink.out" >/dev/null ||
  fail "symlink rejection was not explicit"

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
