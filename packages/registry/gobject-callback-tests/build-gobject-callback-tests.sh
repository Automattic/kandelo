#!/usr/bin/env bash
# Proposed normal package producer. Not run during source preparation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
[[ "$ARCH" == wasm32 ]]
kandelo_package_prepare_build_roots "$SCRIPT_DIR" "$ARCH"
WORK_DIR="$(kandelo_package_make_work_dir gobject-callback-tests)"
trap 'rm -rf "$WORK_DIR"' EXIT
SRC_DIR="$WORK_DIR/source"
: "${WASM_POSIX_DEP_GLIB_DIR:?normal glib dependency required}"
: "${WASM_POSIX_DEP_LIBFFI_DIR:?normal libffi dependency required}"
: "${WASM_POSIX_DEP_PCRE2_DIR:?normal pcre2 dependency required}"
: "${WASM_POSIX_DEP_ZLIB_DIR:?normal zlib dependency required}"
kandelo_package_stage_primary_source gobject-callback-tests "$SRC_DIR" "$WORK_DIR"
# Compile tests from the same patched source contract as the installed library.
# Do not rebuild GLib or alter any assertions, skip list or test selection.
for patch_name in giomodule-no-dbus-builtins wasm-callback-signatures wasm-credentials wasm-interface-init-contract wasm-closure-dispatch-contract; do
    patch --fuzz=0 --batch -d "$SRC_DIR" -p1 < "$REPO_ROOT/packages/registry/glib/src/$patch_name.patch"
done
TEST_DIR="$SRC_DIR/gobject/tests"
GEN_DIR="$WORK_DIR/generated"
mkdir -p "$GEN_DIR"
python3 "$SRC_DIR/gobject/glib-genmarshal.in" --prefix=test --valist-marshallers \
    --output="$GEN_DIR/marshalers.h" --quiet --header "$TEST_DIR/marshalers.list"
python3 "$SRC_DIR/gobject/glib-genmarshal.in" --prefix=test --valist-marshallers \
    --output="$GEN_DIR/marshalers.c" --quiet --body --include-header=marshalers.h "$TEST_DIR/marshalers.list"
cc_flags=(-O2 -g -pthread -I"$WASM_POSIX_DEP_GLIB_DIR/include/glib-2.0" \
    -I"$WASM_POSIX_DEP_LIBFFI_DIR/include" -I"$TEST_DIR" -I"$GEN_DIR")
libs=(-Wl,--start-group "$WASM_POSIX_DEP_GLIB_DIR/lib/libgobject-2.0.a" \
    "$WASM_POSIX_DEP_GLIB_DIR/lib/libgmodule-2.0.a" "$WASM_POSIX_DEP_GLIB_DIR/lib/libglib-2.0.a" \
    "$WASM_POSIX_DEP_LIBFFI_DIR/lib/libffi.a" "$WASM_POSIX_DEP_PCRE2_DIR/lib/libpcre2-8.a" \
    "$WASM_POSIX_DEP_ZLIB_DIR/lib/libz.a" -lm -ldl -Wl,--end-group)
# Both the actual installed library and callbacks remain separate translation
# units; do not use LTO or synthetic copies of GObject/ffi implementation.
"${ARCH}posix-cc" "${cc_flags[@]}" -I"$SCRIPT_DIR" -c "$SCRIPT_DIR/callbacks.c" -o "$WORK_DIR/callbacks.o"
"${ARCH}posix-cc" "${cc_flags[@]}" -I"$SCRIPT_DIR" -c "$SCRIPT_DIR/contract.c" -o "$WORK_DIR/contract.o"
"${ARCH}posix-cc" -pthread "$WORK_DIR/contract.o" "$WORK_DIR/callbacks.o" "${libs[@]}" -o "$WORK_DIR/gobject-contract.wasm"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary gobject-callback-tests "$WORK_DIR/gobject-contract.wasm" gobject-contract.wasm
for name in type basic-signals signals closure defaultiface dynamictype accumulator object references signal-handler; do
    sources=("$TEST_DIR/$name.c")
    case "$name" in
        defaultiface|dynamictype) sources+=("$TEST_DIR/testmodule.c");;
        signals|accumulator) sources+=("$GEN_DIR/marshalers.c");;
    esac
    "${ARCH}posix-cc" "${cc_flags[@]}" "${sources[@]}" "${libs[@]}" -o "$WORK_DIR/gobject-$name.wasm"
    install_local_binary gobject-callback-tests "$WORK_DIR/gobject-$name.wasm" "gobject-$name.wasm"
done
