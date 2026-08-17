#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHELL_BUILDER="$SCRIPT_DIR/build-shell.sh"
BUILD_TOML="$SCRIPT_DIR/build.toml"
PACKAGE_TOML="$SCRIPT_DIR/package.toml"
BUILD_TOOL_PATH="$SCRIPT_DIR/build-tool-path.sh"
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

grep -Eq '^revision[[:space:]]*=[[:space:]]*26$' "$BUILD_TOML" ||
    fail "canonical shell revision must be 26"
grep -Eq '^commit[[:space:]]*=[[:space:]]*"UNPUBLISHED"$' "$BUILD_TOML" ||
    fail "canonical shell must await publication under its authored commit"
grep -Eq '^publication_state[[:space:]]*=[[:space:]]*"pending"$' \
    "$BUILD_TOML" || fail "canonical flat shell must await ABI-43 publication"
for input in \
    homebrew/main-shell-flat-selection.json \
    homebrew/main-shell-materialization-policy.json \
    homebrew/main-shell-runtime-support-policy.json \
    homebrew/main-shell-default.json \
    homebrew/main-shell-flat-demo.json \
    images/vfs/scripts/build-homebrew-flat-lazy-vfs-image.ts \
    images/vfs/scripts/shell-runtime-layout.ts \
    packages/registry/shell/prepare-build-tools.sh \
    crates/shared/src/lib.rs \
    host/src/constants.ts \
    host/src/generated/abi.ts \
    host/src/homebrew-bottle-descriptor.ts \
    host/src/homebrew-bottle-mirror-plan.ts \
    host/src/homebrew-bottle-relocation.ts \
    host/src/homebrew-bottle-selection.ts \
    host/src/homebrew-bottle-types.ts \
    host/src/homebrew-bootstrap-consumer.ts \
    host/src/homebrew-deferred-tree-adapter.ts \
    host/src/homebrew-flat-lazy-vfs-composer.ts \
    host/src/homebrew-guest-layout.ts \
    host/src/homebrew-lazy-layer-descriptor.ts \
    host/src/homebrew-lazy-layer.ts \
    host/src/homebrew-runtime-layer-limits.ts \
    host/src/homebrew-runtime-layer-consumer.ts \
    host/src/homebrew-runtime-layer-policy.ts \
    host/src/homebrew-runtime-support-materializer.ts \
    host/src/homebrew-runtime-support.ts \
    host/src/homebrew-support-data-bottle.ts \
    host/src/homebrew-vfs-builder.ts \
    host/src/homebrew-vfs-composer.ts \
    host/src/homebrew-vfs-fetch.ts \
    host/src/homebrew-vfs-materializer.ts \
    host/src/homebrew-vfs-materialization-policy.ts \
    host/src/homebrew-vfs-planner.ts \
    host/src/homebrew-vfs-resource-policy.ts \
    host/src/pathconf.ts \
    host/src/shell-runtime-layout.ts \
    host/src/statfs.ts \
    host/src/vfs \
    web-libs/kandelo-session/src/shell-config.ts \
    web-libs/kandelo-session/src/demo-config.ts
do
    grep -Fq "\"$input\"" "$BUILD_TOML" ||
        fail "canonical shell cache identity omits $input"
done
grep -Fq '"host/src"' "$BUILD_TOML" &&
    fail "canonical shell cache identity retains the overbroad host/src root"
for retired in \
    main-shell-lazy-artifact-lock.json \
    main-shell-migration-lock.json \
    main-shell-selection-lock.json \
    prepare-homebrew-main-shell-inputs.sh \
    build-homebrew-main-shell-product.sh \
    build-homebrew-materialized-vfs-image.ts
do
    grep -Fq "$retired" "$BUILD_TOML" &&
        fail "canonical shell cache identity retains retired input $retired"
done
grep -Fq 'depends_on = ["homebrew-bootstrap@6.0.12-153-gcf5bc21"]' \
    "$PACKAGE_TOML" || fail "canonical shell omits its selected bootstrap"
[ "$(grep -Fc '[[outputs]]' "$PACKAGE_TOML")" -eq 1 ] ||
    fail "canonical shell must publish exactly one output"
grep -Fq 'wasm = "shell.vfs.zst"' "$PACKAGE_TOML" ||
    fail "canonical shell output must be shell.vfs.zst"
for tool in git node npm tar wc; do
    grep -A4 -F "name = \"$tool\"" "$PACKAGE_TOML" >/dev/null ||
        fail "canonical shell omits declared host tool $tool"
done
for retired_tool in jq python3 ruby sha256sum; do
    grep -Fq "name = \"$retired_tool\"" "$PACKAGE_TOML" &&
        fail "canonical shell retains unused host tool $retired_tool"
done
grep -Fq 'for tool in git node npm tar wc; do' "$BUILD_TOOL_PATH" ||
    fail "Nix host-tool validation differs from package declarations"
if grep -Eq '"[^"]+"[[:space:]]*:[[:space:]]*"file:' \
    "$SCRIPT_DIR/../../../tools/mkrootfs/package.json"
then
    fail "mkrootfs must not hide local source dependencies from the shell cache identity"
fi

FAKE_BIN="$TMP_ROOT/fake-bin"
FAKE_LOG="$TMP_ROOT/node.log"
mkdir -p "$FAKE_BIN"

cat >"$FAKE_BIN/bash" <<'FAKE_BASH'
#!/bin/bash
set -euo pipefail

script="${1:-}"
shift || true
case "$script" in
    */packages/registry/shell/prepare-build-tools.sh)
        for name in \
            GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
            HOMEBREW_GITHUB_PACKAGES_TOKEN \
            HOMEBREW_DOCKER_REGISTRY_TOKEN NPM_TOKEN NODE_AUTH_TOKEN \
            NODE_OPTIONS NODE_PATH NPM_CONFIG_USERCONFIG \
            NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_REGISTRY \
            npm_config_userconfig npm_config_globalconfig \
            npm_config_registry
        do
            if [ "${!name+x}" = x ]; then
                echo "credential leaked to shell tool preparer: $name" >&2
                exit 82
            fi
        done
        exec /bin/bash "$script" "$@"
        ;;
    */scripts/prepare-homebrew-main-shell-inputs.sh|\
    */scripts/build-homebrew-main-shell-product.sh)
        printf 'retired|%s\n' "$script" >>"$FAKE_LOG"
        echo "retired Homebrew shell product was invoked: $script" >&2
        exit 83
        ;;
    *)
        exec /bin/bash "$script" "$@"
        ;;
esac
FAKE_BASH

cat >"$FAKE_BIN/node" <<'FAKE_NODE'
#!/bin/bash
set -euo pipefail

for name in \
    GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
    HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN \
    NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS NODE_PATH \
    NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_REGISTRY \
    npm_config_userconfig npm_config_globalconfig npm_config_registry
do
    if [ "${!name+x}" = x ]; then
        echo "credential leaked to shell composer: $name" >&2
        exit 84
    fi
done
[ "${SOURCE_DATE_EPOCH:-}" = 0 ] || {
    echo "shell wrapper did not pin SOURCE_DATE_EPOCH=0" >&2
    exit 85
}

entrypoint="${1:-}"
shift || true
case "$entrypoint" in
    */tools/mkrootfs/bin/mkrootfs.mjs)
        out=""
        previous=""
        for argument in "$@"; do
            if [ "$previous" = -o ]; then
                out="$argument"
            fi
            previous="$argument"
        done
        [ -n "$out" ] || {
            echo "fake mkrootfs did not receive -o" >&2
            exit 86
        }
        printf 'mkrootfs|%s|%s|%s\n' \
            "$WASM_POSIX_DEP_OUT_DIR" "$entrypoint" "$*" >>"$FAKE_LOG"
        printf 'platform base for %s\n' "$WASM_POSIX_DEP_OUT_DIR" >"$out"
        ;;
    */node_modules/.bin/tsx)
        builder="${1:-}"
        shift || true
        arguments="$*"
        [[ "$builder" == \
            */images/vfs/scripts/build-homebrew-flat-lazy-vfs-image.ts ]] || {
            echo "unexpected tsx entrypoint: $builder" >&2
            exit 87
        }
        out=""
        report=""
        cache=""
        mirror=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --selection|--materialization-policy|--runtime-support-policy|\
                --base-image|--bootstrap-zip|--bootstrap-env|\
                --mirror-repository|--shell-config|--demo-config)
                    shift 2
                    ;;
                --bottle-cache)
                    cache="${2:-}"
                    shift 2
                    ;;
                --mirror-out)
                    mirror="${2:-}"
                    shift 2
                    ;;
                --out)
                    out="${2:-}"
                    shift 2
                    ;;
                --report)
                    report="${2:-}"
                    shift 2
                    ;;
                *)
                    echo "unexpected flat-builder argument: $1" >&2
                    exit 88
                    ;;
            esac
        done
        [ -n "$out" ] && [ -n "$report" ] && [ -n "$cache" ] && \
            [ -n "$mirror" ] || {
            echo "fake lazy builder omitted an isolated output" >&2
            exit 89
        }
        [ -d "$cache" ] && [ ! -L "$cache" ] || {
            echo "lazy builder did not receive an owned bottle cache" >&2
            exit 93
        }
        printf 'lazy|%s|%s|%s|%s\n' \
            "$WASM_POSIX_DEP_OUT_DIR" "$entrypoint" "$builder" \
            "$arguments" >>"$FAKE_LOG"
        if [ "${FAKE_LAZY_FAILURE:-0}" = 1 ]; then
            printf '{}\n' >"$report"
            echo "simulated lazy shell build failure" >&2
            exit 91
        fi
        if [ "${FAKE_OVERSIZE:-0}" = 1 ]; then
            dd if=/dev/zero of="$out" bs=10485760 count=1 2>/dev/null
        else
            printf 'shell VFS for %s\n' "$WASM_POSIX_DEP_OUT_DIR" >"$out"
        fi
        printf '{}\n' >"$report"
        mkdir -m 0700 "$mirror"
        printf '{}\n' >"$mirror/homebrew-bottles.json"
        ;;
    *)
        echo "unexpected node entrypoint: $entrypoint" >&2
        exit 92
        ;;
esac
FAKE_NODE

cat >"$FAKE_BIN/npm" <<'FAKE_NPM'
#!/bin/bash
set -euo pipefail
package_root="$(pwd -P)"
if [[ "$package_root" == */tools/mkrootfs ]]; then
    mkdir -p "$package_root/node_modules/fflate"
else
    mkdir -p "$package_root/node_modules/.bin"
    printf '%s\n' \
        '#!/bin/bash' \
        'exec node "$0" "$@"' \
        >"$package_root/node_modules/.bin/tsx"
    chmod 0755 "$package_root/node_modules/.bin/tsx"
fi
FAKE_NPM

cat >"$FAKE_BIN/tar" <<'FAKE_TAR'
#!/bin/bash
exec /usr/bin/tar "$@"
FAKE_TAR

chmod 0755 "$FAKE_BIN/bash" "$FAKE_BIN/node" "$FAKE_BIN/npm" \
    "$FAKE_BIN/tar"

BOOTSTRAP_DIR="$TMP_ROOT/homebrew-bootstrap"
mkdir "$BOOTSTRAP_DIR"
printf 'bootstrap\n' >"$BOOTSTRAP_DIR/homebrew-bootstrap.zip"
printf 'environment\n' >"$BOOTSTRAP_DIR/homebrew-brew.env"

run_fake_shell_build() {
    local out_dir="$1"
    local fail_lazy="${2:-0}"
    local oversize="${3:-0}"
    local invocation_log="$TMP_ROOT/$(basename "$out_dir").node.log"
    : >"$invocation_log"
    env -u KANDELO_DEV_SHELL_TOOL_PATH \
        PATH="$FAKE_BIN:$PATH" \
        FAKE_LOG="$invocation_log" \
        FAKE_LAZY_FAILURE="$fail_lazy" \
        FAKE_OVERSIZE="$oversize" \
        GH_TOKEN=forbidden \
        GITHUB_TOKEN=forbidden \
        HOMEBREW_GITHUB_API_TOKEN=forbidden \
        HOMEBREW_GITHUB_PACKAGES_TOKEN=forbidden \
        HOMEBREW_DOCKER_REGISTRY_TOKEN=forbidden \
        NPM_TOKEN=forbidden \
        NODE_AUTH_TOKEN=forbidden \
        NODE_OPTIONS=--trace-warnings \
        NODE_PATH="$TMP_ROOT/forbidden-node-path" \
        NPM_CONFIG_USERCONFIG="$TMP_ROOT/forbidden-user.npmrc" \
        NPM_CONFIG_GLOBALCONFIG="$TMP_ROOT/forbidden-global.npmrc" \
        NPM_CONFIG_REGISTRY=https://attacker.invalid/ \
        npm_config_userconfig="$TMP_ROOT/forbidden-lower-user.npmrc" \
        npm_config_globalconfig="$TMP_ROOT/forbidden-lower-global.npmrc" \
        npm_config_registry=https://lower-attacker.invalid/ \
        WASM_POSIX_DEP_OUT_DIR="$out_dir" \
        WASM_POSIX_DEP_HOMEBREW_BOOTSTRAP_DIR="$BOOTSTRAP_DIR" \
        WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
        /bin/bash "$SHELL_BUILDER"
}

parallel_one="$TMP_ROOT/parallel-one"
parallel_two="$TMP_ROOT/parallel-two"
mkdir "$parallel_one" "$parallel_two"
run_fake_shell_build "$parallel_one" &
parallel_one_pid=$!
run_fake_shell_build "$parallel_two" &
parallel_two_pid=$!
wait "$parallel_one_pid" || fail "first concurrent shell build failed"
wait "$parallel_two_pid" || fail "second concurrent shell build failed"
for invocation_log in \
    "$TMP_ROOT/$(basename "$parallel_one").node.log" \
    "$TMP_ROOT/$(basename "$parallel_two").node.log"
do
    while IFS= read -r line; do
        printf '%s\n' "$line" >>"$FAKE_LOG"
    done <"$invocation_log"
done

for out_dir in "$parallel_one" "$parallel_two"; do
    [ -f "$out_dir/shell.vfs.zst" ] ||
        fail "shell wrapper omitted its declared output in $out_dir"
    [ "$(find "$out_dir" -mindepth 1 -maxdepth 1 -print | wc -l | \
        tr -d '[:space:]')" -eq 1 ] ||
        fail "shell wrapper leaked scratch outputs in $out_dir"
    [ ! -e "$out_dir/.homebrew-shell-build" ] ||
        fail "shell wrapper did not clean its private workspace in $out_dir"
done

[ "$(grep -c '^mkrootfs|' "$FAKE_LOG")" -eq 2 ] ||
    fail "shell wrapper did not build two independent platform bases"
[ "$(grep -c '^lazy|' "$FAKE_LOG")" -eq 2 ] ||
    fail "shell wrapper did not run two independent lazy composers"
[ "$(cut -d'|' -f2 "$FAKE_LOG" | sort -u | wc -l | tr -d '[:space:]')" \
    -eq 2 ] || fail "concurrent shell wrappers shared resolver output state"
grep -Fq -- '--sab-size 536870912' "$FAKE_LOG" ||
    fail "platform base omitted the 512 MiB initial capacity"
grep -Fq -- '--max-size 536870912' "$FAKE_LOG" ||
    fail "platform base omitted the 512 MiB maximum capacity"
grep -Fq -- '--kernel-abi 42' "$FAKE_LOG" ||
    fail "platform base omitted ABI 42"

for out_dir in "$parallel_one" "$parallel_two"; do
    source_root="$out_dir/.homebrew-shell-build/source"
    grep -Fq -- \
        "--selection $source_root/homebrew/main-shell-flat-selection.json" \
        "$FAKE_LOG" || fail "shell wrapper omitted canonical selection"
    grep -Fq -- \
        "--materialization-policy $source_root/homebrew/main-shell-materialization-policy.json" \
        "$FAKE_LOG" || fail "shell wrapper omitted materialization policy"
    grep -Fq -- \
        "--runtime-support-policy $source_root/homebrew/main-shell-runtime-support-policy.json" \
        "$FAKE_LOG" || fail "shell wrapper omitted runtime-support policy"
    grep -Fq -- \
        "--bootstrap-zip $BOOTSTRAP_DIR/homebrew-bootstrap.zip --bootstrap-env $BOOTSTRAP_DIR/homebrew-brew.env" \
        "$FAKE_LOG" || fail "shell wrapper omitted selected bootstrap outputs"
    grep -Fq -- \
        "--mirror-repository kandelo-dev/homebrew-tap-core --mirror-out $out_dir/.homebrew-shell-build/mirror" \
        "$FAKE_LOG" || fail "shell wrapper omitted sealed mirror handoff"
    grep -Fq -- \
        "--shell-config $source_root/homebrew/main-shell-default.json" \
        "$FAKE_LOG" || fail "shell wrapper omitted canonical shell config"
    grep -Fq -- \
        "--demo-config $source_root/homebrew/main-shell-flat-demo.json" \
        "$FAKE_LOG" || fail "shell wrapper omitted canonical demo config"
    grep -Fq -- \
        "--out $out_dir/.homebrew-shell-build/shell.vfs.zst --report $out_dir/.homebrew-shell-build/main-shell-report.json" \
        "$FAKE_LOG" ||
        fail "shell wrapper omitted private lazy outputs"
done

if grep -q '^retired|' "$FAKE_LOG"; then
    fail "shell wrapper invoked the retired lazy-shell product lane"
fi
grep -Fq 'prepare-homebrew-main-shell-inputs.sh' "$SHELL_BUILDER" &&
    fail "shell wrapper retained the retired input preparer"
grep -Fq 'build-homebrew-main-shell-product.sh' "$SHELL_BUILDER" &&
    fail "shell wrapper retained the retired product builder"

failed_out="$TMP_ROOT/failed"
mkdir "$failed_out"
expect_failure "simulated lazy shell build failure" \
    run_fake_shell_build "$failed_out" 1
[ ! -e "$failed_out/.homebrew-shell-build" ] ||
    fail "failed shell build leaked its private workspace"
[ -z "$(find "$failed_out" -mindepth 1 -maxdepth 1 -print -quit)" ] ||
    fail "failed shell build published a partial output"

expect_failure "WASM_POSIX_DEP_OUT_DIR is required" \
    env -u WASM_POSIX_DEP_OUT_DIR -u KANDELO_DEV_SHELL_TOOL_PATH \
        PATH="$FAKE_BIN:$PATH" WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
        /bin/bash "$SHELL_BUILDER"
missing_bootstrap="$TMP_ROOT/missing-bootstrap"
mkdir "$missing_bootstrap"
expect_failure "requires WASM_POSIX_DEP_HOMEBREW_BOOTSTRAP_DIR" \
    env -u WASM_POSIX_DEP_HOMEBREW_BOOTSTRAP_DIR \
        -u KANDELO_DEV_SHELL_TOOL_PATH PATH="$FAKE_BIN:$PATH" \
        WASM_POSIX_DEP_OUT_DIR="$missing_bootstrap" \
        WASM_POSIX_DEP_TARGET_ARCH=wasm32 /bin/bash "$SHELL_BUILDER"

oversized_out="$TMP_ROOT/oversized"
mkdir "$oversized_out"
expect_failure "canonical lazy shell must be smaller than 10 MiB" \
    run_fake_shell_build "$oversized_out" 0 1
[ -z "$(find "$oversized_out" -mindepth 1 -maxdepth 1 -print -quit)" ] ||
    fail "oversized shell build published a partial output"
wrong_arch="$TMP_ROOT/wrong-arch"
mkdir "$wrong_arch"
expect_failure "supports only wasm32" \
    env -u KANDELO_DEV_SHELL_TOOL_PATH \
        PATH="$FAKE_BIN:$PATH" WASM_POSIX_DEP_OUT_DIR="$wrong_arch" \
        WASM_POSIX_DEP_TARGET_ARCH=x86_64 /bin/bash "$SHELL_BUILDER"
[ -z "$(find "$wrong_arch" -mindepth 1 -maxdepth 1 -print -quit)" ] ||
    fail "wrong-arch rejection changed resolver output"

echo "test-build-shell: ok"
