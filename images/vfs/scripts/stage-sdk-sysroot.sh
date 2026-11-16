#!/usr/bin/env bash
#
# Copy the guest SDK's sysroot content out of a build-machine sysroot.
#
# Usage:
#   stage-sdk-sysroot.sh <source-sysroot> <destination>
#
# The build machine's sysroot is a shared, mutable directory. Its declared
# content is what scripts/build-musl.sh produces (musl, Kandelo's overlay
# headers and startup objects) plus the platform graphics libraries that
# scripts/build-dri-stubs.sh and scripts/build-gles-stubs.sh add. Other
# tools stage more into the same directory: scripts/build-programs.sh
# copies resolved library archives and headers (glib, GTK, SDL2, Wayland
# and others) there for its test fixtures. Copying the whole directory made
# every SDK artifact's bytes depend on whether such a tool had run first,
# under a cache key that does not cover it.
#
# This script copies only the declared content:
#   - every path in the musl output receipt (.kandelo-musl.outputs.json),
#     after checking each against its recorded digest;
#   - the remaining files build-musl.sh installs (MUSL_LIBRARY_FILES);
#   - the graphics libraries, headers and pkg-config files
#     (GRAPHICS_FILES, GRAPHICS_TREES).
# Every listed file must be present, so a sysroot missing part of the SDK
# fails here instead of producing a smaller artifact. Anything else in the
# source sysroot is left behind. libc++ is not sysroot content: callers
# copy it from their declared libcxx dependency.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

fail() {
    echo "stage-sdk-sysroot: $*" >&2
    exit 1
}

if [ "$#" -ne 2 ]; then
    echo "usage: $0 <source-sysroot> <destination>" >&2
    exit 2
fi
SOURCE="$1"
DEST="$2"

[ -d "$SOURCE" ] && [ ! -L "$SOURCE" ] ||
    fail "source sysroot is not a directory: $SOURCE"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    [ -d "$DEST" ] && [ ! -L "$DEST" ] && [ -z "$(ls -A "$DEST")" ] ||
        fail "destination must be absent or an empty directory: $DEST"
fi

# Installed by musl's `make install` (CRT_LIBS, EMPTY_LIBS) and by the
# extra build steps in scripts/build-musl.sh, but not in its receipt.
MUSL_LIBRARY_FILES=(
    lib/Scrt1.o
    lib/rcrt1.o
    lib/libcrypt.a
    lib/libdl.a
    lib/libm.a
    lib/libpthread.a
    lib/libresolv.a
    lib/librt.a
    lib/libutil.a
    lib/libxnet.a
    lib/__main_void.o
    lib/__main_void_adapter.o
    lib/sigsetjmp_helpers.o
    lib/wasm_setjmp_rt.o
)
# The sysroot graphics contract (docs/sdk-guide.md, "Sysroot platform
# libraries"): scripts/build-dri-stubs.sh and scripts/build-gles-stubs.sh.
GRAPHICS_FILES=(
    lib/libEGL.a
    lib/libGLESv2.a
    lib/libdrm.a
    lib/libgbm.a
    lib/pkgconfig/egl.pc
    lib/pkgconfig/gbm.pc
    lib/pkgconfig/glesv2.pc
    lib/pkgconfig/libdrm.pc
)
GRAPHICS_TREES=(
    include/drm
    include/libdrm
)

RECEIPT=.kandelo-musl.outputs.json
OUTPUT_STATE="$REPO_ROOT/scripts/musl-output-state.mjs"
[ -f "$SOURCE/$RECEIPT" ] ||
    fail "no musl output receipt at $SOURCE/$RECEIPT; rebuild the sysroot with scripts/build-musl.sh"
node "$OUTPUT_STATE" check "$SOURCE" ||
    fail "$SOURCE no longer matches its musl output receipt; rebuild it with scripts/build-musl.sh"

receipt_paths=()
while IFS= read -r path; do
    receipt_paths+=("$path")
done < <(node -e '
const outputs = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
for (const path of Object.keys(outputs).sort()) console.log(path);
' "$SOURCE/$RECEIPT")
[ "${#receipt_paths[@]}" -gt 0 ] || fail "musl output receipt lists no files"

copy_file() {
    local path="$1"
    if [ ! -f "$SOURCE/$path" ] || [ -L "$SOURCE/$path" ]; then
        fail "required SDK sysroot file missing or not a regular file: $SOURCE/$path"
    fi
    mkdir -p "$DEST/$(dirname "$path")"
    cp "$SOURCE/$path" "$DEST/$path"
}

mkdir -p "$DEST"
for path in "${receipt_paths[@]}" "${MUSL_LIBRARY_FILES[@]}" "${GRAPHICS_FILES[@]}"; do
    copy_file "$path"
done
for tree in "${GRAPHICS_TREES[@]}"; do
    if [ ! -d "$SOURCE/$tree" ] || [ -L "$SOURCE/$tree" ]; then
        fail "required SDK sysroot directory missing: $SOURCE/$tree"
    fi
    if [ -n "$(find "$SOURCE/$tree" ! -type d ! -type f -print -quit)" ]; then
        fail "SDK sysroot directory holds a non-regular file: $SOURCE/$tree"
    fi
    mkdir -p "$DEST/$(dirname "$tree")"
    cp -R "$SOURCE/$tree" "$DEST/$tree"
done

# Check the copied bytes, not just the source: the shared sysroot can be
# rewritten while this runs. The receipt is build-machine state, not guest
# content, so it does not stay in the staged tree.
cp "$SOURCE/$RECEIPT" "$DEST/$RECEIPT"
node "$OUTPUT_STATE" check "$DEST" ||
    fail "the staged sysroot does not match the musl output receipt; $SOURCE changed during staging"
rm -f "$DEST/$RECEIPT"

echo "    sysroot: $(find "$DEST" -type f | wc -l | tr -d ' ') files staged from $SOURCE"
