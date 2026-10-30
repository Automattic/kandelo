#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/dependency" "$work/tools"
cp abi/program-fixtures/v55/echo.wasm "$work/dependency/js.wasm"
printf '#!/usr/bin/env bash\nexit 99\n' > "$work/tools/cargo"
chmod +x "$work/tools/cargo"
export PATH="$work/tools:$PATH"
export WASM_POSIX_XTASK_BIN="$root/target/$(rustc -vV | awk '/^host/ {print $2}')/debug/xtask"
for package in node spidermonkey-node; do
    mkdir -p "$work/$package/work" "$work/$package/out"
    WASM_POSIX_DEP_NAME="$package" \
    WASM_POSIX_DEP_WORK_DIR="$work/$package/work" \
    WASM_POSIX_DEP_OUT_DIR="$work/$package/out" \
    WASM_POSIX_DEP_SPIDERMONKEY_DIR="$work/dependency" \
    WASM_POSIX_INSTALL_OUTPUT_METADATA='[{"source_artifact":"node.wasm","mirror_path":"node.wasm","fork_instrumentation":"auto"}]' \
        bash packages/registry/spidermonkey-node/build-spidermonkey-node.sh
    cmp "$work/dependency/js.wasm" "$work/$package/out/node.wasm"
    test "$(find "$work/$package/out" -type f | wc -l | tr -d ' ')" = 1
done
export WASM_POSIX_DEP_WORK_DIR="$work/refused/work"
export WASM_POSIX_DEP_OUT_DIR="$work/refused/out"
export WASM_POSIX_DEP_NAME=node
export WASM_POSIX_INSTALL_OUTPUT_METADATA='[{"source_artifact":"node.wasm","mirror_path":"node.wasm","fork_instrumentation":"auto"}]'
mkdir -p "$WASM_POSIX_DEP_WORK_DIR" "$WASM_POSIX_DEP_OUT_DIR"
for refusal in missing-dependency missing-output unknown-package unsupported-arch; do
    if (
        export WASM_POSIX_DEP_SPIDERMONKEY_DIR="$work/dependency"
        case "$refusal" in
            missing-dependency) unset WASM_POSIX_DEP_SPIDERMONKEY_DIR ;;
            missing-output) export WASM_POSIX_DEP_SPIDERMONKEY_DIR="$work/missing" ;;
            unknown-package) export WASM_POSIX_DEP_NAME=unexpected ;;
            unsupported-arch) export WASM_POSIX_DEP_TARGET_ARCH=wasm64 ;;
        esac
        bash packages/registry/spidermonkey-node/build-spidermonkey-node.sh
    ) > "$work/$refusal.log" 2>&1; then
        echo "unexpected staging success: $refusal" >&2
        exit 1
    fi
    test ! -e "$WASM_POSIX_DEP_OUT_DIR/node.wasm"
done
cmp abi/program-fixtures/v55/echo.wasm "$work/dependency/js.wasm"
echo 'SpiderMonkey package-owned staging: PASS'
