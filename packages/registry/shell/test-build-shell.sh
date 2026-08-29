#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SHELL_BUILDER="$SCRIPT_DIR/build-shell.sh"
BUILD_TOML="$SCRIPT_DIR/build.toml"
PACKAGE_TOML="$SCRIPT_DIR/package.toml"
CONTRACT="$SCRIPT_DIR/source-rootfs-shell-dependencies.json"
CONTRACT_READER="$SCRIPT_DIR/source-rootfs-shell-dependency-contract.mjs"
TMP_ROOT="$(mktemp -d)"

cleanup() {
    rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
    echo "test-build-shell: $*" >&2
    exit 1
}

expect_failure() {
    local expected="$1"
    shift
    local output
    if output="$("$@" 2>&1)"; then
        fail "command unexpectedly succeeded: $*"
    fi
    grep -Fq -- "$expected" <<<"$output" || {
        printf '%s\n' "$output" >&2
        fail "failure did not contain: $expected"
    }
}

grep -Eq '^revision[[:space:]]*=[[:space:]]*35$' "$BUILD_TOML" ||
    fail "canonical source shell revision must be 35"
grep -Eq '^commit[[:space:]]*=[[:space:]]*"UNPUBLISHED"$' "$BUILD_TOML" ||
    fail "canonical source shell must await publication"
grep -Eq '^publication_state[[:space:]]*=[[:space:]]*"pending"$' \
    "$BUILD_TOML" || fail "canonical source shell must remain pending"

for canonical_input in \
    packages/registry/shell/build-shell.sh \
    packages/registry/shell/source-rootfs-shell-dependencies.json \
    packages/registry/shell/source-rootfs-shell-demo-profiles.json \
    packages/registry/shell/source-rootfs-shell-dependency-contract.mjs \
    images/vfs/scripts/build-source-rootfs-shell-image.ts \
    images/vfs/scripts/source-rootfs-shell-overlay.ts \
    images/vfs/scripts/shell-lazy-archives.ts \
    images/vfs/scripts/generate-mandoc-db.ts \
    images/vfs/scripts/vfs-image-helpers.ts \
    images/vfs/lib/init/shell-binaries.ts \
    host/src/binary-resolver.ts \
    host/src/file-offset.ts \
    host/src/vfs/memory-fs.ts \
    host/src/vfs/tar.ts \
    host/src/vfs/zip.ts \
    web-libs/kandelo-session/src/experimental-terminal-session.ts \
    web-libs/kandelo-session/src/demo-config.ts \
    web-libs/kandelo-session/src/vfs-capacity.ts \
    package.json package-lock.json
do
    [ -e "$REPO_ROOT/$canonical_input" ] ||
        fail "canonical shell input does not exist: $canonical_input"
    grep -Fq "\"$canonical_input\"" "$BUILD_TOML" ||
        fail "canonical shell cache identity omits $canonical_input"
done

for forbidden in \
    prepare-build-tools.sh \
    resolve-binary.sh npm\ install bottle-cache mirror-repository
do
    grep -Fq "$forbidden" "$PACKAGE_TOML" "$BUILD_TOML" "$SHELL_BUILDER" &&
        fail "canonical shell retains forbidden recipe input $forbidden"
done
grep -Eq '\bcurl\b|\bwget\b' "$SHELL_BUILDER" &&
    fail "canonical wrapper contains a network client"

mapfile -t declared_dependencies < <(
    node "$CONTRACT_READER" --print-resolver-owned "$CONTRACT" "$PACKAGE_TOML"
)
[ "${#declared_dependencies[@]}" -eq 33 ] ||
    fail "canonical contract must expose 33 lazy resolver dependencies"
[ "$(grep -Fc '[[outputs]]' "$PACKAGE_TOML")" -eq 1 ] ||
    fail "canonical shell must publish exactly one output"
grep -Fq 'wasm = "shell.vfs.zst"' "$PACKAGE_TOML" ||
    fail "canonical shell output must be shell.vfs.zst"
[ "$(grep -Fc '[[host_tools]]' "$PACKAGE_TOML")" -eq 1 ] ||
    fail "canonical shell must declare only its actual Node host tool"
grep -Fq 'name = "node"' "$PACKAGE_TOML" ||
    fail "canonical shell omits Node"

FAKE_BIN="$TMP_ROOT/fake-bin"
FAKE_LOG="$TMP_ROOT/composer.log"
REAL_NODE="$(type -P node)"
mkdir "$FAKE_BIN"

cat >"$FAKE_BIN/node" <<'FAKE_NODE'
#!/bin/bash
set -euo pipefail

if [[ "${1:-}" == */source-rootfs-shell-dependency-contract.mjs ]]; then
    exec "$REAL_NODE" "$@"
fi
for name in \
    GH_TOKEN GITHUB_TOKEN \
    NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS NODE_PATH \
    NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_REGISTRY \
    npm_config_userconfig npm_config_globalconfig npm_config_registry \
    ALL_PROXY HTTPS_PROXY HTTP_PROXY NO_PROXY \
    all_proxy https_proxy http_proxy no_proxy
do
    [ "${!name+x}" != x ] || {
        echo "ambient variable leaked to shell composer: $name" >&2
        exit 81
    }
done
[ "${SOURCE_DATE_EPOCH:-}" = 0 ] || {
    echo "shell wrapper did not pin SOURCE_DATE_EPOCH" >&2
    exit 82
}
tsx="${1:-}"
composer="${2:-}"
shift 2
[[ "$tsx" == */node_modules/tsx/dist/cli.mjs ]] || exit 83
[[ "$composer" == */images/vfs/scripts/build-source-rootfs-shell-image.ts ]] || exit 84
printf '%s\n' "$*" >>"$FAKE_LOG"
out=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --rootfs|--bash|--fbdoom|--modeset|--demo-config|\
        --demo-profile-overlay|--dependency-contract)
            [ -f "${2:-}" ] || { echo "missing input for $1" >&2; exit 85; }
            shift 2
            ;;
        --out)
            out="${2:-}"
            shift 2
            ;;
        *) echo "unexpected composer argument: $1" >&2; exit 86 ;;
    esac
done
[ -n "$out" ] || exit 87
if [ "${FAKE_COMPOSER_FAILURE:-0}" = 1 ]; then
    echo "simulated source shell build failure" >&2
    exit 88
fi
printf 'source shell\n' >"$out"
FAKE_NODE
chmod 0755 "$FAKE_BIN/node"

make_fixture() {
    local name="$1"
    local root="$TMP_ROOT/$name"
    mkdir -p "$root/out" "$root/work" "$root/rootfs" "$root/bash" \
        "$root/fbdoom" "$root/modeset" "$root/dependencies"
    printf 'rootfs\n' >"$root/rootfs/rootfs.vfs"
    printf 'bash\n' >"$root/bash/bash.wasm"
    printf 'fbdoom\n' >"$root/fbdoom/fbdoom.wasm"
    printf 'modeset\n' >"$root/modeset/modeset.wasm"
    local dependency
    for dependency in "${declared_dependencies[@]}"; do
        mkdir "$root/dependencies/$dependency"
    done
}

run_fixture() {
    local name="$1"
    local fail_composer="${2:-0}"
    local root="$TMP_ROOT/$name"
    local dependency dependency_key
    local env_args=(
        "REAL_NODE=$REAL_NODE"
        "FAKE_LOG=$FAKE_LOG"
        "FAKE_COMPOSER_FAILURE=$fail_composer"
        "KANDELO_DEV_SHELL_TOOL_PATH=$FAKE_BIN"
        "WASM_POSIX_DEP_TARGET_ARCH=wasm32"
        "WASM_POSIX_DEP_OUT_DIR=$root/out"
        "WASM_POSIX_DEP_WORK_DIR=$root/work"
        "WASM_POSIX_DEP_ROOTFS_DIR=$root/rootfs"
        "WASM_POSIX_DEP_BASH_DIR=$root/bash"
        "WASM_POSIX_DEP_FBDOOM_DIR=$root/fbdoom"
        "WASM_POSIX_DEP_MODESET_DIR=$root/modeset"
    )
    for dependency in "${declared_dependencies[@]}"; do
        dependency_key="$(printf '%s' "$dependency" | tr '[:lower:]-' '[:upper:]_')"
        env_args+=(
            "WASM_POSIX_DEP_${dependency_key}_DIR=$root/dependencies/$dependency"
        )
    done
    env "${env_args[@]}" \
        GH_TOKEN=forbidden GITHUB_TOKEN=forbidden \
        NODE_OPTIONS=--trace-warnings NODE_PATH=/forbidden \
        HTTP_PROXY=https://proxy.invalid HTTPS_PROXY=https://proxy.invalid \
        /bin/bash "$SHELL_BUILDER"
}

: >"$FAKE_LOG"
make_fixture parallel-one
make_fixture parallel-two
run_fixture parallel-one &
parallel_one_pid=$!
run_fixture parallel-two &
parallel_two_pid=$!
wait "$parallel_one_pid" || fail "first concurrent shell build failed"
wait "$parallel_two_pid" || fail "second concurrent shell build failed"

for name in parallel-one parallel-two; do
    [ -f "$TMP_ROOT/$name/out/shell.vfs.zst" ] ||
        fail "$name omitted shell.vfs.zst"
    [ "$(find "$TMP_ROOT/$name/out" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d '[:space:]')" -eq 1 ] ||
        fail "$name published more than its declared output"
    [ -z "$(find "$TMP_ROOT/$name/work" -mindepth 1 -maxdepth 1 -print -quit)" ] ||
        fail "$name leaked resolver scratch state"
done
[ "$(wc -l <"$FAKE_LOG" | tr -d '[:space:]')" -eq 2 ] ||
    fail "concurrent builds did not make two isolated composer invocations"
if grep -Fq -- "--shell-config" "$FAKE_LOG"; then
    fail "wrapper still passes the removed shell-config input"
fi
grep -Fq -- \
    "--demo-profile-overlay $SCRIPT_DIR/source-rootfs-shell-demo-profiles.json" \
    "$FAKE_LOG" || fail "wrapper omitted canonical demo profile overlay"

make_fixture failed
expect_failure "simulated source shell build failure" run_fixture failed 1
[ -z "$(find "$TMP_ROOT/failed/out" -mindepth 1 -maxdepth 1 -print -quit)" ] ||
    fail "failed build published a partial output"
[ -z "$(find "$TMP_ROOT/failed/work" -mindepth 1 -maxdepth 1 -print -quit)" ] ||
    fail "failed build leaked scratch state"

make_fixture wrong-arch
expect_failure "supports only wasm32" env \
    WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/wrong-arch/out" \
    WASM_POSIX_DEP_WORK_DIR="$TMP_ROOT/wrong-arch/work" \
    WASM_POSIX_DEP_ROOTFS_DIR="$TMP_ROOT/wrong-arch/rootfs" \
    WASM_POSIX_DEP_BASH_DIR="$TMP_ROOT/wrong-arch/bash" \
    WASM_POSIX_DEP_FBDOOM_DIR="$TMP_ROOT/wrong-arch/fbdoom" \
    WASM_POSIX_DEP_MODESET_DIR="$TMP_ROOT/wrong-arch/modeset" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm64 \
    KANDELO_DEV_SHELL_TOOL_PATH="$FAKE_BIN" \
    /bin/bash "$SHELL_BUILDER"
[ -z "$(find "$TMP_ROOT/wrong-arch/out" -mindepth 1 -maxdepth 1 -print -quit)" ] ||
    fail "wrong-architecture rejection changed resolver output"

echo "test-build-shell: ok"
