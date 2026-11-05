#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'chmod -R u+w "$work" 2>/dev/null || true; rm -rf "$work"' EXIT
mkdir "$work/bin" "$work/sources" "$work/output" "$work/store"

bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" --help >/dev/null
export WASM_POSIX_FORK_INSTRUMENT="$REPO_ROOT/tools/bin/wasm-fork-instrument"
for tool in rustc cargo; do
    printf '#!/usr/bin/env bash\nprintf "unexpected tool lookup\\n" >>"$ORIGINAL_TOOL_PROBE"\nexit 97\n' >"$work/bin/$tool"
    chmod +x "$work/bin/$tool"
done
export ORIGINAL_TOOL_PROBE="$work/tool-probe"
export PATH="$work/bin:$PATH"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
export WASM_POSIX_DEP_OUT_DIR="$work/output"
export WASM_POSIX_BUILD_ORIGINAL_STORE="$work/store"
export WASM_POSIX_DEP_TARGET_ARCH=wasm32
export WASM_POSIX_DEP_NAME=fixture
source "$REPO_ROOT/scripts/install-local-binary.sh"

fail() {
    echo "test-install-original-program.sh: $*" >&2
    exit 1
}

declare_output() {
    export WASM_POSIX_INSTALL_OUTPUT_METADATA="[{\"source_artifact\":\"$1.wasm\",\"mirror_path\":\"$1.wasm\",\"fork_instrumentation\":\"auto\",\"original_wasm\":\"originals/$1.wasm\"}]"
}

cat >"$work/fork.wat" <<'WAT'
(module
  (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start") (drop (call $fork (i32.const 0)))))
WAT
wat2wasm "$work/fork.wat" -o "$work/sources/raw"
cp "$work/sources/raw" "$work/expected-original"
chmod 0555 "$work/sources/raw"
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$work/sources/raw" \
    -o "$work/sources/renamed" --post-optimize none
rm "$work/sources/raw"
declare_output app
install_local_binary fixture "$work/sources/renamed" app.wasm
cmp "$work/expected-original" "$work/output/originals/app.wasm"
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$work/output/app.wasm" \
    --verify-original "$work/output/originals/app.wasm"
[ ! -x "$work/output/originals/app.wasm" ] || fail "raw companion is executable"

printf '(module (func (export "_start")))\n' >"$work/plain.wat"
wat2wasm "$work/plain.wat" -o "$work/sources/plain"
cp "$work/sources/plain" "$work/expected-plain"
declare_output plain
install_local_binary fixture "$work/sources/plain" plain.wasm
cmp "$work/expected-plain" "$work/output/originals/plain.wasm"
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$work/output/plain.wasm" \
    --verify-original "$work/output/originals/plain.wasm"

declare_output missing
mkdir "$work/empty-store"
printf 'keep previous executable\n' >"$work/output/missing.wasm"
if WASM_POSIX_BUILD_ORIGINAL_STORE="$work/empty-store" \
    install_local_binary fixture "$work/sources/renamed" missing.wasm; then
    fail "installed prepared program with no original"
fi
[ "$(cat "$work/output/missing.wasm")" = "keep previous executable" ] || fail "missing original replaced executable"
[ ! -e "$work/output/originals/missing.wasm" ] || fail "invented an original"

declare_output corrupt
reference="$("$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$work/sources/renamed" --original-reference)"
IFS=$'\t' read -r length digest <<<"$reference"
mkdir -p "$work/corrupt-store/originals"
printf 'corrupt original\n' >"$work/corrupt-store/originals/$digest.wasm"
if WASM_POSIX_BUILD_ORIGINAL_STORE="$work/corrupt-store" \
    install_local_binary fixture "$work/sources/renamed" corrupt.wasm; then
    fail "accepted corrupt original"
fi
[ ! -e "$work/output/corrupt.wasm" ] || fail "published after corrupt original"

for mode in 0555 0644; do
    declare_output "unsafe-$mode"
    chmod "$mode" "$work/store/originals/$digest.wasm"
    if install_local_binary fixture "$work/sources/renamed" "unsafe-$mode.wasm"; then
        fail "accepted unsafe original mode $mode"
    fi
    [ ! -e "$work/output/unsafe-$mode.wasm" ] || fail "published after unsafe original mode"
done
chmod 0444 "$work/store/originals/$digest.wasm"

declare_output escape
mkdir "$work/symlink-output" "$work/outside"
ln -s "$work/outside" "$work/symlink-output/originals"
if WASM_POSIX_DEP_OUT_DIR="$work/symlink-output" \
    install_local_binary fixture "$work/sources/renamed" escape.wasm; then
    fail "followed companion destination symlink"
fi
[ ! -e "$work/outside/escape.wasm" ] || fail "wrote outside output root"
[ ! -e "$work/symlink-output/escape.wasm" ] || fail "published after companion refusal"

declare_output wrong-package
if WASM_POSIX_DEP_NAME=other install_local_binary fixture "$work/sources/renamed" wrong-package.wasm; then
    fail "accepted metadata from a different package"
fi
[ ! -e "$work/output/wrong-package.wasm" ] || fail "published from wrong-package metadata"

export WASM_POSIX_INSTALL_OUTPUT_METADATA='[{"source_artifact":"dash.wasm","mirror_path":"dash.wasm","fork_instrumentation":"auto","original_wasm":"-"}]'
install_local_binary fixture "$work/sources/renamed" dash.wasm
cmp "$work/expected-original" "$work/output/-"

declare_output ambiguous
export WASM_POSIX_INSTALL_OUTPUT_METADATA='[{"source_artifact":"one/app.wasm"},{"source_artifact":"two/app.wasm"}]'
if install_local_binary fixture "$work/sources/renamed" app.wasm; then
    fail "accepted ambiguous output declaration"
fi
[ ! -e "$ORIGINAL_TOOL_PROBE" ] || fail "sealed installer invoked Cargo or rustc"
echo "test-install-original-program.sh: ok"
