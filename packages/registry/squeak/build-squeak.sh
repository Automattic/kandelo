#!/usr/bin/env bash
# Build the OpenSmalltalk/Squeak Spur stack VM for wasm32-posix-kernel.
#
# The stack interpreter is slower than Sista/Cog, but it gets the main Squeak
# 6.0 release image much farther on wasm32 today. The Sista/Cog build reached
# the splash screen but then hit eden/allocation and SmallInteger DNU failures.
set -euo pipefail

SQUEAK_COMMIT="${SQUEAK_COMMIT:-cc2dd909045721f6cbf16cb62f5662fe68158021}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/opensmalltalk-vm-src"
BUILD_DIR="$SCRIPT_DIR/build"
BIN_DIR="$SCRIPT_DIR/bin"

source "$REPO_ROOT/sdk/activate.sh"
export PATH="$REPO_ROOT/sdk/bin:$PATH"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
export WASM_POSIX_MAX_MEMORY="${WASM_POSIX_MAX_MEMORY:-4294967296}"
export CONFIG_SITE="$REPO_ROOT/sdk/config.site"

if [ ! -f "$WASM_POSIX_SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash scripts/build-musl.sh" >&2
    exit 1
fi
bash "$REPO_ROOT/scripts/install-overlay-headers.sh" "$WASM_POSIX_SYSROOT"

if [ ! -d "$SRC_DIR/.git" ]; then
    echo "==> Cloning OpenSmalltalk VM..."
    git clone --filter=blob:none https://github.com/OpenSmalltalk/opensmalltalk-vm "$SRC_DIR"
fi

cd "$SRC_DIR"
if [ "$(git rev-parse HEAD)" != "$SQUEAK_COMMIT" ]; then
    echo "==> Checking out OpenSmalltalk VM $SQUEAK_COMMIT..."
    git fetch --filter=blob:none origin "$SQUEAK_COMMIT"
    git checkout --force "$SQUEAK_COMMIT"
fi

echo "==> Applying wasm32-posix patches..."
for patch in "$SCRIPT_DIR/patches/"*.patch; do
    [ -f "$patch" ] || continue
    if git apply --recount --check "$patch" >/dev/null 2>&1; then
        git apply --recount "$patch"
    else
        echo "    $(basename "$patch") already applied or superseded"
    fi
done

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$BIN_DIR"

: > "$BUILD_DIR/plugins.int"
: > "$BUILD_DIR/plugins.ext"

cd "$BUILD_DIR"

echo "==> Configuring Squeak Spur stack VM for wasm32-posix..."
"$SRC_DIR/platforms/unix/config/configure" \
    --host=wasm32-unknown-none \
    --prefix=/usr \
    --disable-shared \
    --enable-static \
    --with-vmversion=5.0 \
    --with-src=src/spur32.stack \
    --disable-cogit \
    --without-npsqueak \
    --without-x \
    --without-gl \
    --without-zlib \
    --disable-iconv \
    --disable-epoll \
    --with-scriptname=squeak \
    CC=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    NM=wasm32posix-nm \
    STRIP=wasm32posix-strip \
    ac_cv_header_libevdev_1_0_libevdev_libevdev_h=yes \
    ac_cv_sizeof_int=4 \
    ac_cv_sizeof_long=4 \
    ac_cv_sizeof_long_long=8 \
    ac_cv_sizeof_void_p=4 \
    CFLAGS="-O2 -fno-strict-aliasing -fwrapv -DNDEBUG -DDEBUGVM=0 -DMUSL -DNOEVDEV -DSTACK_FP_ALIGNMENT=0 -DLSB_FIRST=1 -DHAVE_CONFIG_H -Wno-incompatible-function-pointer-types -I$REPO_ROOT/sysroot/include" \
    LIBS="-lm"

echo "==> Compiling static display and sound modules..."
MODULE_CFLAGS=(
    -O2 -fno-strict-aliasing -fwrapv -DNDEBUG -DDEBUGVM=0 -DMUSL -DNOEVDEV -DSTACK_FP_ALIGNMENT=0 -DHAVE_CONFIG_H -DLSB_FIRST=1
    -Wno-incompatible-function-pointer-types
    -I"$BUILD_DIR"
    -I"$REPO_ROOT/sysroot/include"
    -I"$SRC_DIR/platforms/unix/vm"
    -I"$SRC_DIR/platforms/Cross/vm"
    -I"$SRC_DIR/src/spur32.stack"
    -I"$SRC_DIR/platforms/unix/vm-display-fbdev"
    -I"$SRC_DIR/platforms/Cross/plugins/FilePlugin"
    -I"$SRC_DIR/platforms/Cross/plugins/B3DAcceleratorPlugin"
    -I"$SRC_DIR/platforms/unix/plugins/B3DAcceleratorPlugin"
)
wasm32posix-cc "${MODULE_CFLAGS[@]}" \
    -c "$SRC_DIR/platforms/unix/vm-display-fbdev/sqUnixFBDev.c" \
    -o sqUnixFBDev.o
wasm32posix-cc "${MODULE_CFLAGS[@]}" \
    -c "$SRC_DIR/platforms/unix/vm-sound-OSS/sqUnixSoundOSS.c" \
    -o sqUnixSoundOSS.o

echo "==> Building VM support objects..."
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
VM_SUPPORT_OBJECTS=(
    sqNamedPrims.o
    sqVirtualMachine.o
    sqHeapMap.o
    sqExternalSemaphores.o
    sqTicker.o
    aio.o
    debug.o
    osExports.o
    sqUnixExternalPrims.o
    sqUnixMemory.o
    sqUnixSpurMemory.o
    sqUnixCharConv.o
    sqUnixMain.o
    sqUnixVMProfile.o
    sqUnixHeartbeat.o
    sqUnixThreads.o
    sqUnixDisplayHelpers.o
)
make -C vm -j"$JOBS" AR=wasm32posix-ar "${VM_SUPPORT_OBJECTS[@]}"
"$SRC_DIR/platforms/unix/config/verstamp" version.c wasm32posix-cc
wasm32posix-cc "${MODULE_CFLAGS[@]}" -c version.c -o version.o
wasm32posix-cc "${MODULE_CFLAGS[@]}" -c disabledPlugins.c -o disabledPlugins.o

echo "==> Compiling stack interpreter..."
wasm32posix-cc "${MODULE_CFLAGS[@]}" \
    -Wno-unused-value \
    -Wno-pointer-sign \
    -Wno-incompatible-pointer-types-discards-qualifiers \
    -Wno-format \
    -I"$SRC_DIR/platforms/unix/plugins/FilePlugin" \
    -c "$SRC_DIR/src/spur32.stack/interp.c" \
    -o vm/interp.o

CORE_OBJECTS=(
    disabledPlugins.o
    version.o
)
for obj in "${VM_SUPPORT_OBJECTS[@]}"; do
    CORE_OBJECTS+=("vm/$obj")
done

cat > main-adapter.c <<'EOF'
extern char **environ;
extern int main(int argc, char **argv, char **envp);
int __main_argc_argv(int argc, char **argv) { return main(argc, argv, environ); }
EOF
wasm32posix-cc "${MODULE_CFLAGS[@]}" -c main-adapter.c -o main-adapter.o

echo "==> Linking Squeak VM..."
wasm32posix-cc \
    -O2 -fno-strict-aliasing -fwrapv -DNDEBUG -DDEBUGVM=0 -DMUSL -DNOEVDEV -DSTACK_FP_ALIGNMENT=0 \
    -Wno-incompatible-function-pointer-types \
    -o squeak \
    main-adapter.o \
    sqUnixFBDev.o \
    sqUnixSoundOSS.o \
    vm/interp.o \
    "${CORE_OBJECTS[@]}" \
    -lm \
    -pthread

if [ "$(wc -c < squeak | tr -d ' ')" -lt 100000 ]; then
    echo "ERROR: squeak output is unexpectedly small" >&2
    exit 1
fi

cp squeak "$BIN_DIR/squeak.wasm"
cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary squeak "$BIN_DIR/squeak.wasm"

ls -lh "$BIN_DIR/squeak.wasm"
echo "==> Squeak VM built."
