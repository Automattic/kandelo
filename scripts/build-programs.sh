#!/bin/bash
set -euo pipefail

# Build user programs (programs/*.c) into local-binaries/programs/.
# The resolver (host/src/binary-resolver.ts) prefers local-binaries/
# over binaries/, so locally-built binaries automatically override
# whatever the fetcher placed under `binaries/`.
# Uses the same toolchain and flags as libc-test builds.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/libc/glue"
# Per-arch output dirs match the layout the resolver's
# `place_binaries_symlinks` writes:
# binaries/programs/<arch>/ and local-binaries/programs/<arch>/.
# wasm32 and wasm64 builds share program names (e.g. hello64.wasm)
# so they MUST live in separate trees — a flat OUT_DIR would
# last-write-wins across arches.
OUT_DIR_32="$REPO_ROOT/local-binaries/programs/wasm32"
OUT_DIR_64="$REPO_ROOT/local-binaries/programs/wasm64"
mkdir -p "$OUT_DIR_32" "$OUT_DIR_64"

# Auto-detect LLVM (same logic as SDK / run-libc-tests.sh)
find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ]; then echo "$LLVM_BIN"; return; fi
    local brew_prefix
    if brew_prefix=$(brew --prefix llvm 2>/dev/null) && [ -d "$brew_prefix/bin" ]; then
        echo "$brew_prefix/bin"; return
    fi
    for v in 21 20 19 18 17 16 15; do
        if [ -x "/usr/bin/clang-$v" ]; then echo "/usr/bin"; return; fi
    done
    if command -v clang >/dev/null 2>&1; then echo "$(dirname "$(command -v clang)")"; return; fi
    echo "Error: LLVM/clang not found. Set LLVM_BIN or install LLVM." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"

# Verify prerequisites
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi

CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -mllvm -wasm-enable-sjlj
    -mllvm -wasm-use-legacy-eh=false
    # Upstream libdrm installs public headers under `include/libdrm/`
    # (matches the `--cflags` pkg-config flag). Programs `#include
    # <xf86drm.h>` from there. `include/drm/` is the UAPI dir that
    # xf86drm.h itself transitively pulls in via `#include <drm.h>`;
    # both dirs must be on the search path or the upstream header
    # fan-out doesn't resolve. Harmless when the dirs are absent.
    -I"$SYSROOT/include/libdrm"
    -I"$SYSROOT/include/drm"
)

LINK_PRE_LIBS=(
    "$GLUE_DIR/channel_syscall.c"
    "$GLUE_DIR/compiler_rt.c"
    "$SYSROOT/lib/crt1.o"
)

# libc.a + linker flags. Per-program extra archives (libdrm.a, libgbm.a,
# libEGL.a, libGLESv2.a) are spliced BEFORE libc.a so the stubs'
# internal references (mmap, ioctl, calloc, …) resolve in a single
# linker pass.
LINK_POST_LIBS=(
    "$SYSROOT/lib/libc.a"
    -Wl,--entry=_start
    -Wl,--export=_start
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=1073741824
    -Wl,--allow-undefined
    -Wl,--table-base=3
    -Wl,--export-table
    -Wl,--growable-table
    -Wl,--export=__wasm_init_tls
    -Wl,--export=__tls_base
    -Wl,--export=__tls_size
    -Wl,--export=__tls_align
    -Wl,--export=__stack_pointer
    -Wl,--export=__wasm_thread_init
    -Wl,--export=__abi_version
)

# Fork support comes from wasm-fork-instrument. The tool auto-discovers
# fork-path functions via call-graph analysis from `kernel.kernel_fork`;
# no onlylist is needed.
# See docs/fork-instrumentation.md.
FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"

build_program() {
    local src="$1"
    local out_dir="$2"
    shift 2
    local extra_libs=("$@")
    local name
    name=$(basename "$src" .c)
    local wasm="$out_dir/${name}.wasm"

    # Auto-append GL stubs when the source pulls in EGL/GLES headers.
    # Static linking won't pick symbols out of libEGL.a / libGLESv2.a
    # unless the program references them, so this is a no-op for
    # non-GL programs even if the archives are appended.
    if grep -qE '^[[:space:]]*#[[:space:]]*include[[:space:]]*[<"](EGL|GLES[23]?)/' "$src" 2>/dev/null; then
        if [ -f "$SYSROOT/lib/libEGL.a" ] && [ -f "$SYSROOT/lib/libGLESv2.a" ]; then
            extra_libs+=("$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a")
        else
            echo "  Skipping $name: GL archives missing — run scripts/build-gles-stubs.sh." >&2
            return 0
        fi
    fi

    echo "  Compiling $name..."
    # Bash 3.2 (macOS system bash) under `set -u` treats expansion of
    # an empty array as unbound; the `${arr[@]+...}` guard suppresses
    # that when extra_libs is empty.
    "$CC" "${CFLAGS[@]}" "$src" \
        "${LINK_PRE_LIBS[@]}" \
        ${extra_libs[@]+"${extra_libs[@]}"} \
        "${LINK_POST_LIBS[@]}" \
        -o "$wasm"

    # Apply fork instrumentation if the program uses fork. The tool is a
    # no-op for modules without `kernel.kernel_fork`, so it's safe to run
    # unconditionally on every program. Programs without fork stay
    # byte-identical except for a small ABI metadata section the tool
    # always emits (see runtime::inject_runtime).
    "$FORK_INSTRUMENT" "$wasm" -o "$wasm.instr"
    mv "$wasm.instr" "$wasm"
}

# Build a C++ program via the SDK's wasm32posix-c++ wrapper. The SDK
# injects the toolchain's standard compile + link flags, the channel
# syscall glue, the C++ runtime stubs (cxxrt.c), and the sysroot path.
# The default include search includes the sysroot's libc++ headers so
# no extra -isystem is needed; we only have to supply -lc++ / -lc++abi
# at link time.
build_cpp_program() {
    local src="$1"
    local out_dir="$2"
    local name
    name=$(basename "$src" .cpp)
    local wasm="$out_dir/${name}.wasm"

    echo "  Compiling $name (C++)..."
    # -fwasm-exceptions is required for clang to lower C++ try/catch
    # to wasm-EH `try`/`catch` instructions. Without it clang emits
    # `__cxa_throw; unreachable` and DCEs the catch handlers, so the
    # whole exception-propagation chain (libunwind + libc++abi) never
    # runs.
    wasm32posix-c++ \
        -O2 \
        -fwasm-exceptions \
        "$src" \
        -lc++ -lc++abi \
        -o "$wasm"

    # Phase 7: fork support comes from wasm-fork-instrument. The tool is
    # a no-op for modules without `kernel.kernel_fork`, so it's safe to
    # run unconditionally — programs without fork stay byte-identical
    # except for the ABI metadata section.
    "$FORK_INSTRUMENT" "$wasm" -o "$wasm.instr"
    mv "$wasm.instr" "$wasm"
}

# libwpkdraw (PR7): in-tree CPU rasterizer + font engine. Built inline
# (NOT via the resolver — it walks packages/registry/ only, and wpkdraw is
# pure in-tree source with no upstream tarball). build.sh installs
# lib/libwpkdraw.a + include/wpkdraw/ into the sysroot; consumers
# (wpkdraw_smoke, kwldemo, wlterm, wlcompositor, wlclock, wlpaint)
# then link libwpkdraw.a and #include
# <wpkdraw/…> off the sysroot include path. Runs before the flat program
# loop so the wpkdraw_smoke.c case branch below can link it. See
# docs/plans/2026-07-09-dri-pr7-libkwl-wlterm-plan.md §3.
WPKDRAW_DIR="$REPO_ROOT/examples/libs/wpkdraw"
if [ -d "$WPKDRAW_DIR/src" ]; then
    echo "==> Building libwpkdraw (CPU rasterizer)..."
    CC="$CC" AR="$LLVM_BIN/llvm-ar" bash "$WPKDRAW_DIR/build.sh" "$SYSROOT"
fi

# Resolve libcxx and symlink its outputs into the sysroot if there are
# any .cpp programs to build. Skip the resolver entirely when libc++.a
# is already present so repeat runs are fast.
if ls "$REPO_ROOT/programs/"*.cpp >/dev/null 2>&1; then
    if [ ! -f "$SYSROOT/lib/libc++.a" ]; then
        echo "==> Resolving libcxx for C++ programs..."
        HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
        (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libcxx >/dev/null)
        LIBCXX_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libcxx)"
        ln -sf "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
        ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
        mkdir -p "$SYSROOT/include/c++"
        rm -rf "$SYSROOT/include/c++/v1"
        ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"
    fi
fi

# Resolve SDL2 and symlink its outputs (and its deps' outputs) into
# the sysroot if there are any sdl2_*_smoke.c programs or any source
# under programs/sdl2/ to build. We re-resolve + re-symlink on every
# run because SDL2 has transitive deps (alsa-lib, libdrm,
# libinput-lite) whose cache dirs shift independently when their
# `build.toml.revision` bumps. The previous fast-path guarded on
# `libSDL2.a` only, so a dep bump produced a fresh sdl2 cache while
# the sysroot symlinks for libasound.a / libdrm.a / libinput.a stayed
# pointing at the pre-bump caches — programs then linked against
# stale dep archives.
# See docs/plans/2026-06-16-dri-kandelo-port-handoff-54.md §B4.
# The resolver is idempotent + cached, so re-running it is cheap when
# nothing changed.
if ls "$REPO_ROOT"/programs/sdl2_*.c >/dev/null 2>&1 \
        || ls "$REPO_ROOT"/programs/sdl2/*.c >/dev/null 2>&1; then
    echo "==> Resolving sdl2 (and deps) for SDL2 programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve sdl2 >/dev/null)
    SDL2_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path sdl2)"
    ALSA_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path alsa-lib)"
    LIBDRM_PREFIX_SDL2="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libdrm)"
    LIBINPUT_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libinput-lite)"

    ln -sfn "$SDL2_PREFIX/lib/libSDL2.a"       "$SYSROOT/lib/libSDL2.a"
    ln -sfn "$ALSA_PREFIX/lib/libasound.a"     "$SYSROOT/lib/libasound.a"
    ln -sfn "$LIBDRM_PREFIX_SDL2/lib/libdrm.a" "$SYSROOT/lib/libdrm.a"
    ln -sfn "$LIBINPUT_PREFIX/lib/libinput.a"  "$SYSROOT/lib/libinput.a"

    mkdir -p "$SYSROOT/include/SDL2"
    for h in "$SDL2_PREFIX/include/SDL2"/*.h; do
        ln -sfn "$h" "$SYSROOT/include/SDL2/$(basename "$h")"
    done
fi

# Resolve libwayland (+ its deps libffi + wayland-protocols) and symlink
# its client/server archives, the libffi shim archive, and the public
# headers into the sysroot when there are any wl_*.c programs to build.
# libwayland's protocol glue is generated at resolve time from the
# vendored wayland.xml by the flake's wayland-scanner, so this step needs
# the dev shell (scripts/dev-shell.sh) on PATH. Re-resolved every run —
# the resolver is cached, so it's cheap when nothing changed. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md (PR3).
if ls "$REPO_ROOT"/programs/wl_*.c >/dev/null 2>&1; then
    echo "==> Resolving libwayland (and deps) for Wayland programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libwayland >/dev/null)
    LIBWL_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libwayland)"
    LIBFFI_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libffi)"

    ln -sfn "$LIBWL_PREFIX/lib/libwayland-client.a" "$SYSROOT/lib/libwayland-client.a"
    ln -sfn "$LIBWL_PREFIX/lib/libwayland-server.a" "$SYSROOT/lib/libwayland-server.a"
    ln -sfn "$LIBFFI_PREFIX/lib/libffi.a"           "$SYSROOT/lib/libffi.a"

    for h in "$LIBWL_PREFIX/include"/wayland-*.h; do
        ln -sfn "$h" "$SYSROOT/include/$(basename "$h")"
    done
fi

# Resolve libxkbcommon and symlink its archive + public headers into the
# sysroot when there are any xkb_*.c programs to build. Same cached-resolve
# contract as the libwayland block above. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md (PR4).
if ls "$REPO_ROOT"/programs/xkb_*.c >/dev/null 2>&1; then
    echo "==> Resolving libxkbcommon for XKB programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libxkbcommon >/dev/null)
    LIBXKB_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libxkbcommon)"

    ln -sfn "$LIBXKB_PREFIX/lib/libxkbcommon.a" "$SYSROOT/lib/libxkbcommon.a"
    mkdir -p "$SYSROOT/include/xkbcommon"
    for h in "$LIBXKB_PREFIX/include/xkbcommon"/*.h; do
        ln -sfn "$h" "$SYSROOT/include/xkbcommon/$(basename "$h")"
    done
fi

# Resolve libevdev and symlink its archive + public header into the sysroot
# when there are any libevdev_*.c programs to build. Same cached-resolve
# contract as the libwayland/libxkbcommon blocks above. libevdev is the
# foundation of the real libinput port (PR5). See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5).
if ls "$REPO_ROOT"/programs/libevdev_*.c >/dev/null 2>&1; then
    echo "==> Resolving libevdev for evdev programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libevdev >/dev/null)
    LIBEVDEV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libevdev)"

    ln -sfn "$LIBEVDEV_PREFIX/lib/libevdev.a" "$SYSROOT/lib/libevdev.a"
    mkdir -p "$SYSROOT/include/libevdev"
    ln -sfn "$LIBEVDEV_PREFIX/include/libevdev/libevdev.h" "$SYSROOT/include/libevdev/libevdev.h"
fi

# Resolve mtdev and symlink its archive + headers into the sysroot when
# there are any mtdev_*.c programs to build. mtdev is the link-only
# multitouch dependency of the real libinput port (PR5). Same
# cached-resolve contract as the blocks above. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5b).
if ls "$REPO_ROOT"/programs/mtdev_*.c >/dev/null 2>&1; then
    echo "==> Resolving mtdev for mtdev programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve mtdev >/dev/null)
    MTDEV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path mtdev)"

    ln -sfn "$MTDEV_PREFIX/lib/libmtdev.a" "$SYSROOT/lib/libmtdev.a"
    ln -sfn "$MTDEV_PREFIX/include/mtdev.h" "$SYSROOT/include/mtdev.h"
    ln -sfn "$MTDEV_PREFIX/include/mtdev-plumbing.h" "$SYSROOT/include/mtdev-plumbing.h"
fi

# Resolve libudev and symlink its archive + header into the sysroot when
# there are any libudev_*.c programs to build. libudev is the input_id
# classification shim the real libinput port (PR5) needs to accept
# devices. Same cached-resolve contract as the blocks above. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5b).
if ls "$REPO_ROOT"/programs/libudev_*.c >/dev/null 2>&1; then
    echo "==> Resolving libudev for libudev programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libudev >/dev/null)
    LIBUDEV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libudev)"

    ln -sfn "$LIBUDEV_PREFIX/lib/libudev.a" "$SYSROOT/lib/libudev.a"
    ln -sfn "$LIBUDEV_PREFIX/include/libudev.h" "$SYSROOT/include/libudev.h"
fi

# Resolve libinput (real 1.25.0) for the libinput smoke. Unlike the
# libinput-lite stub SDL2 links (see the sdl2 block), this is the real
# path-backend library the Wayland compositor will use (PR5c). The smoke is
# built in a dedicated pass after the program loop (build_program can't add
# the real header's -I), and links the real archive from its cache prefix by
# full path — deliberately NOT via $SYSROOT/lib/libinput.a, which belongs to
# the lite stub — so the two libinput consumers never collide. Its deps
# (libevdev + libudev shim + mtdev stub) resolve transitively; we capture
# each prefix for the smoke's link line. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5c).
LIBINPUT_REAL_PREFIX=""
if ls "$REPO_ROOT"/programs/libinput_smoke.c >/dev/null 2>&1; then
    echo "==> Resolving libinput (real 1.25.0) for the libinput smoke..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libinput >/dev/null)
    LIBINPUT_REAL_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libinput)"
    LIBINPUT_LIBEVDEV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libevdev)"
    LIBINPUT_LIBUDEV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libudev)"
    LIBINPUT_MTDEV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path mtdev)"
fi

echo "Building user programs..."
for src in "$REPO_ROOT/programs/"*.c; do
    [ -f "$src" ] || continue
    # Skip hello64.c — built separately with wasm64 toolchain below
    [ "$(basename "$src")" = "hello64.c" ] && continue
    # DRI programs link against the libdrm / libgbm shims
    # (sysroot/lib/libdrm.a, libgbm.a). EGL/GLES2 stubs are picked up
    # by build_program's header-based auto-detection.
    case "$(basename "$src")" in
        modeset.c|dri-modeset.c|dumb_roundtrip.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a"
            ;;
        libdrm-kms-smoke.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libdrm.a"
            ;;
        wpkdraw_smoke.c)
            # PR7 Phase 1: links the in-tree CPU rasterizer built above.
            # Headers resolve from $SYSROOT/include/wpkdraw/.
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libwpkdraw.a"
            ;;
        kwldemo.c|wlclock.c|wlpaint.c)
            # Link libkwl — built in a dedicated pass after the
            # wlcompositor block (which resolves the wayland/xkb archives and
            # generates the xdg-shell client header libkwl needs). Skip here.
            ;;
        libinput_stub_smoke.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libinput.a"
            ;;
        gbm_surface_smoke.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a"
            ;;
        alsa_lib_smoke.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libasound.a"
            ;;
        wl_smoke.c)
            # In-process client+server proof. Both archives share the
            # util/connection/protocol objects; on-demand archive
            # resolution pulls each once (server.a first), so linking
            # both is duplicate-free. libffi (the wl_closure_invoke
            # shim) must come AFTER so ffi_call/ffi_prep_cif resolve.
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libwayland-server.a" \
                "$SYSROOT/lib/libwayland-client.a" \
                "$SYSROOT/lib/libffi.a"
            ;;
        xkb_smoke.c)
            # Keymap compile + state translation against the libxkbcommon port.
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libxkbcommon.a"
            ;;
        libevdev_smoke.c)
            # evdev capability probe + event decode against the libevdev port.
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libevdev.a"
            ;;
        mtdev_smoke.c)
            # Link-only proof of the mtdev stub + not-protocol-A check.
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libmtdev.a"
            ;;
        libudev_input_id_smoke.c)
            # input_id classification through the libudev shim's real API.
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libudev.a"
            ;;
        libinput_smoke.c)
            # Real libinput 1.25.0 path backend — built in a dedicated pass
            # after this loop (needs the real <libinput.h> include + its full
            # dep set, kept isolated from the libinput-lite stub). Skip here.
            ;;
        sdl2_kmsdrm_smoke.c)
            # SDL2 KMSDRM backend links statically against libdrm + libgbm.
            # Audio + evdev objects are present in libSDL2.a too but the
            # smoke calls SDL_Init(SDL_INIT_VIDEO) only, so the audio /
            # input archives don't need to be on the link line.
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libSDL2.a" \
                "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a"
            ;;
        sdl2_alsa_smoke.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libSDL2.a" \
                "$SYSROOT/lib/libasound.a" \
                "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a"
            ;;
        sdl2_evdev_smoke.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libSDL2.a" \
                "$SYSROOT/lib/libinput.a" \
                "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a"
            ;;
        *)
            build_program "$src" "$OUT_DIR_32"
            ;;
    esac
done

# libinput smoke — real libinput 1.25.0. Dedicated compile/link (not
# build_program): it needs the real <libinput.h> from the resolved prefix,
# kept off the sysroot so $SYSROOT/lib/libinput.a stays the libinput-lite
# stub SDL2 links. -I on the real prefix wins over the sysroot's stale lite
# libinput.h. Link order: dependents before dependencies (libinput →
# libevdev / libudev / mtdev → libc). See PR5c.
if [ -n "$LIBINPUT_REAL_PREFIX" ] && [ -f "$REPO_ROOT/programs/libinput_smoke.c" ]; then
    libinput_wasm="$OUT_DIR_32/libinput_smoke.wasm"
    echo "  Compiling libinput_smoke (real libinput 1.25.0)..."
    "$CC" "${CFLAGS[@]}" "-I$LIBINPUT_REAL_PREFIX/include" \
        "$REPO_ROOT/programs/libinput_smoke.c" \
        "${LINK_PRE_LIBS[@]}" \
        "$LIBINPUT_REAL_PREFIX/lib/libinput.a" \
        "$LIBINPUT_LIBEVDEV_PREFIX/lib/libevdev.a" \
        "$LIBINPUT_LIBUDEV_PREFIX/lib/libudev.a" \
        "$LIBINPUT_MTDEV_PREFIX/lib/libmtdev.a" \
        "${LINK_POST_LIBS[@]}" \
        -o "$libinput_wasm"
    "$FORK_INSTRUMENT" "$libinput_wasm" -o "$libinput_wasm.instr"
    mv "$libinput_wasm.instr" "$libinput_wasm"
fi

# Wayland compositor (PR6): a standalone libwayland *server* (wlcompositor)
# plus a raw libwayland-client test client (wlclient-test), built as two
# binaries. Both compile in the xdg-shell protocol glue that wayland-scanner
# (flake) generates from the vendored XML; the server also links real
# libinput (PR5) + libxkbcommon (PR4) + libgbm/libdrm for card0 compositing.
# Dedicated pass (not build_program): it needs the generated -I dir, the real
# <libinput.h> from its cache prefix, and a multi-archive link line. Files
# live under programs/wlcompositor/ so the flat programs/*.c loop doesn't
# pick them up. See docs/plans/2026-07-08-dri-wayland-compositor-plan.md
# §5 (PR6).
if ls "$REPO_ROOT"/programs/wlcompositor/*.c >/dev/null 2>&1; then
    echo "==> Building wlcompositor (Wayland server + test client)..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    wlc_resolve() { (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve "$1" >/dev/null); }
    wlc_path() { (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path "$1"); }

    wlc_resolve libwayland
    wlc_resolve libxkbcommon
    wlc_resolve libinput
    WLC_LIBWL="$(wlc_path libwayland)"
    WLC_LIBFFI="$(wlc_path libffi)"
    WLC_LIBXKB="$(wlc_path libxkbcommon)"
    WLC_LIBINPUT="$(wlc_path libinput)"
    WLC_LIBEVDEV="$(wlc_path libevdev)"
    WLC_LIBUDEV="$(wlc_path libudev)"
    WLC_MTDEV="$(wlc_path mtdev)"

    # SDL2 (step 12c): its upstream Wayland+GLES backend is the first
    # third-party GL client of wlcompositor. Resolve it here (the earlier
    # sdl2_*.c block only fires for programs/sdl2*), so sdl2gl-test can link
    # libSDL2.a + the wayland client stack below.
    wlc_resolve sdl2 || true
    WLC_SDL2="$(wlc_path sdl2 2>/dev/null || true)"

    # Public headers on the sysroot include path (idempotent — the wl_*/xkb_*
    # blocks above symlink the same paths; the archives too).
    for h in "$WLC_LIBWL/include"/wayland-*.h; do
        ln -sfn "$h" "$SYSROOT/include/$(basename "$h")"
    done
    ln -sfn "$WLC_LIBFFI/lib/libffi.a"            "$SYSROOT/lib/libffi.a"
    ln -sfn "$WLC_LIBWL/lib/libwayland-server.a"  "$SYSROOT/lib/libwayland-server.a"
    ln -sfn "$WLC_LIBWL/lib/libwayland-client.a"  "$SYSROOT/lib/libwayland-client.a"
    ln -sfn "$WLC_LIBWL/lib/libwayland-cursor.a"  "$SYSROOT/lib/libwayland-cursor.a"
    ln -sfn "$WLC_LIBXKB/lib/libxkbcommon.a"      "$SYSROOT/lib/libxkbcommon.a"
    mkdir -p "$SYSROOT/include/xkbcommon"
    for h in "$WLC_LIBXKB/include/xkbcommon"/*.h; do
        ln -sfn "$h" "$SYSROOT/include/xkbcommon/$(basename "$h")"
    done

    # Generate xdg-shell {server,client} headers + shared private-code from
    # the vendored protocol XML. Kept out of programs/ so it isn't globbed.
    WLC_GEN="$REPO_ROOT/local-binaries/wlcompositor-gen"
    mkdir -p "$WLC_GEN"
    XDG_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/xdg-shell.xml"
    wayland-scanner private-code  "$XDG_XML" "$WLC_GEN/xdg-shell-protocol.c"
    wayland-scanner server-header "$XDG_XML" "$WLC_GEN/xdg-shell-server-protocol.h"
    wayland-scanner client-header "$XDG_XML" "$WLC_GEN/xdg-shell-client-protocol.h"

    # Same for zwp_linux_dmabuf_v1 (PR11): the compositor's GPU-tier client
    # buffer path. Server side is compiled into wlcompositor; the client
    # header + private-code drive wldmabuf-test.
    DMABUF_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/linux-dmabuf-v1.xml"
    wayland-scanner private-code  "$DMABUF_XML" "$WLC_GEN/linux-dmabuf-v1-protocol.c"
    wayland-scanner server-header "$DMABUF_XML" "$WLC_GEN/linux-dmabuf-v1-server-protocol.h"
    wayland-scanner client-header "$DMABUF_XML" "$WLC_GEN/linux-dmabuf-v1-client-protocol.h"

    # libwayland-egl (step 12a): the wl_egl_window shim that SDL2's upstream
    # Wayland+GLES backend uses as its EGLNativeWindowType. It allocates the
    # GPU-tier bo the window renders into and wraps it as a zwp_linux_dmabuf_v1
    # wl_buffer; libEGL targets that bo's FBO and attach+commits it on swap
    # (see libc/glue/libwayland-egl.c). Self-contained: bundles the dmabuf
    # client glue since neither SDL2 nor libwayland ships it, so a GL client
    # only links libwayland-egl.a + libEGL.a. Public headers are vendored
    # verbatim from wayland 1.24.0 under libc/glue/wayland-egl-include/.
    echo "  Building libwayland-egl.a (wl_egl_window shim)..."
    for h in wayland-egl.h wayland-egl-core.h wayland-egl-backend.h; do
        ln -sfn "$GLUE_DIR/wayland-egl-include/$h" "$SYSROOT/include/$h"
    done
    "$CC" "${CFLAGS[@]}" "-I$WLC_GEN" "-I$GLUE_DIR" \
        "-I$GLUE_DIR/wayland-egl-include" -c \
        "$GLUE_DIR/libwayland-egl.c" -o "$WLC_GEN/libwayland-egl.o"
    "$CC" "${CFLAGS[@]}" "-I$WLC_GEN" -c \
        "$WLC_GEN/linux-dmabuf-v1-protocol.c" -o "$WLC_GEN/linux-dmabuf-v1-protocol.o"
    "$LLVM_BIN/llvm-ar" rcs "$SYSROOT/lib/libwayland-egl.a" \
        "$WLC_GEN/libwayland-egl.o" "$WLC_GEN/linux-dmabuf-v1-protocol.o"

    # Server. Link order: dependents (compositor + xdg glue) before
    # dependencies; libffi last so wl_closure_invoke's ffi_call resolves.
    # libwpkdraw renders the compositor's wallpaper (gradient + wordmark);
    # libEGL/libGLESv2 drive the GPU compositing path (CPU fallback when
    # the host has no WebGL2).
    comp_wasm="$OUT_DIR_32/wlcompositor.wasm"
    echo "  Compiling wlcompositor (server)..."
    "$CC" "${CFLAGS[@]}" "-I$WLC_GEN" "-I$WLC_LIBINPUT/include" \
        "$REPO_ROOT/programs/wlcompositor/wlcompositor.c" \
        "$WLC_GEN/xdg-shell-protocol.c" \
        "$WLC_GEN/linux-dmabuf-v1-protocol.c" \
        "${LINK_PRE_LIBS[@]}" \
        "$SYSROOT/lib/libwayland-server.a" \
        "$SYSROOT/lib/libwpkdraw.a" \
        "$SYSROOT/lib/libxkbcommon.a" \
        "$WLC_LIBINPUT/lib/libinput.a" \
        "$WLC_LIBEVDEV/lib/libevdev.a" \
        "$WLC_LIBUDEV/lib/libudev.a" \
        "$WLC_MTDEV/lib/libmtdev.a" \
        "$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a" \
        "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
        "$SYSROOT/lib/libffi.a" \
        "${LINK_POST_LIBS[@]}" \
        -o "$comp_wasm"
    "$FORK_INSTRUMENT" "$comp_wasm" -o "$comp_wasm.instr"
    mv "$comp_wasm.instr" "$comp_wasm"

    # Client.
    client_wasm="$OUT_DIR_32/wlclient-test.wasm"
    echo "  Compiling wlclient-test (client)..."
    "$CC" "${CFLAGS[@]}" "-I$WLC_GEN" \
        "$REPO_ROOT/programs/wlcompositor/wlclient-test.c" \
        "$WLC_GEN/xdg-shell-protocol.c" \
        "${LINK_PRE_LIBS[@]}" \
        "$SYSROOT/lib/libwayland-client.a" \
        "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
        "$SYSROOT/lib/libffi.a" \
        "${LINK_POST_LIBS[@]}" \
        -o "$client_wasm"
    "$FORK_INSTRUMENT" "$client_wasm" -o "$client_wasm.instr"
    mv "$client_wasm.instr" "$client_wasm"

    # dmabuf client (PR11): drives the zwp_linux_dmabuf_v1 buffer path so
    # host/test/wlcompositor-dmabuf-smoke.test.ts can assert the compositor
    # composites a dmabuf-imported buffer. Links the dmabuf client glue.
    if [ -f "$REPO_ROOT/programs/wlcompositor/wldmabuf-test.c" ]; then
        dmabuf_wasm="$OUT_DIR_32/wldmabuf-test.wasm"
        echo "  Compiling wldmabuf-test (dmabuf client)..."
        "$CC" "${CFLAGS[@]}" "-I$WLC_GEN" \
            "$REPO_ROOT/programs/wlcompositor/wldmabuf-test.c" \
            "$WLC_GEN/xdg-shell-protocol.c" \
            "$WLC_GEN/linux-dmabuf-v1-protocol.c" \
            "${LINK_PRE_LIBS[@]}" \
            "$SYSROOT/lib/libwayland-client.a" \
            "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
            "$SYSROOT/lib/libffi.a" \
            "${LINK_POST_LIBS[@]}" \
            -o "$dmabuf_wasm"
        "$FORK_INSTRUMENT" "$dmabuf_wasm" -o "$dmabuf_wasm.instr"
        mv "$dmabuf_wasm.instr" "$dmabuf_wasm"
    fi

    # SDL2 GLES2 client (step 12c): drives SDL2's upstream Wayland+GLES
    # backend against the compositor — the first third-party toolkit to
    # exercise the wl_egl_window shim + libEGL bo-FBO targeting + dmabuf
    # present chain (steps 10/11/12). Links libSDL2.a with the full
    # wayland client stack: libwayland-egl.a FIRST (it defines
    # wl_egl_window_* and bundles the dmabuf client glue), then
    # libwayland-client/cursor + libxkbcommon (SDL's static wayland
    # symbols) + libEGL/libGLESv2 + libgbm/libdrm (the GL/bo backend) +
    # libffi (wl_closure_invoke). Runtime-proven only in the browser
    # (WebGL2) via apps/browser-demos/test/kandelo-sdl2gl.spec.ts.
    if [ -n "$WLC_SDL2" ] \
            && [ -f "$REPO_ROOT/programs/wlcompositor/sdl2gl-test.c" ]; then
        sdl2gl_wasm="$OUT_DIR_32/sdl2gl-test.wasm"
        echo "  Compiling sdl2gl-test (SDL2 GLES2 wayland client)..."
        "$CC" "${CFLAGS[@]}" "-I$WLC_SDL2/include" \
            "$REPO_ROOT/programs/wlcompositor/sdl2gl-test.c" \
            "${LINK_PRE_LIBS[@]}" \
            "$WLC_SDL2/lib/libSDL2.a" \
            "$SYSROOT/lib/libwayland-egl.a" \
            "$SYSROOT/lib/libwayland-client.a" \
            "$SYSROOT/lib/libwayland-cursor.a" \
            "$SYSROOT/lib/libxkbcommon.a" \
            "$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a" \
            "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
            "$SYSROOT/lib/libffi.a" \
            "${LINK_POST_LIBS[@]}" \
            -o "$sdl2gl_wasm"
        "$FORK_INSTRUMENT" "$sdl2gl_wasm" -o "$sdl2gl_wasm.instr"
        mv "$sdl2gl_wasm.instr" "$sdl2gl_wasm"
    fi

    # wlcube (step 13): a raw libwayland-egl GLES2 client (no toolkit) driving
    # the same GL path as sdl2gl-test. libwayland-egl.a must link FIRST — it
    # defines wl_egl_window_* and bundles the dmabuf client glue — ahead of
    # libwayland-client, the xdg-shell glue, and the GL/gbm/drm/ffi stack.
    # Fork-instrumented for parity with the other wl_display_connect clients
    # (wlcube itself does not fork).
    if [ -f "$REPO_ROOT/programs/wlcompositor/wlcube.c" ]; then
        wlcube_wasm="$OUT_DIR_32/wlcube.wasm"
        echo "  Compiling wlcube (raw libwayland-egl GLES2 client)..."
        "$CC" "${CFLAGS[@]}" "-I$WLC_GEN" \
            "$REPO_ROOT/programs/wlcompositor/wlcube.c" \
            "$WLC_GEN/xdg-shell-protocol.c" \
            "${LINK_PRE_LIBS[@]}" \
            "$SYSROOT/lib/libwayland-egl.a" \
            "$SYSROOT/lib/libwayland-client.a" \
            "$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a" \
            "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
            "$SYSROOT/lib/libffi.a" \
            "${LINK_POST_LIBS[@]}" \
            -o "$wlcube_wasm"
        "$FORK_INSTRUMENT" "$wlcube_wasm" -o "$wlcube_wasm.instr"
        mv "$wlcube_wasm.instr" "$wlcube_wasm"
    fi
fi

# libkwl (PR7 Phase 2): in-tree Wayland toolkit over libwayland-client.
# Built inline (NOT via the resolver — packages/registry/ only). Runs AFTER
# the wlcompositor block above so the wayland-client / xkbcommon / gbm /
# drm / ffi archives are already symlinked into the sysroot and the
# generated xdg-shell-client-protocol.h exists under local-binaries/
# wlcompositor-gen (libkwl includes it). build.sh installs lib/libkwl.a +
# include/kwl.h; the kwldemo consumer then links libkwl + libwpkdraw + the
# wayland stack. See docs/plans/2026-07-09-dri-pr7-libkwl-wlterm-plan.md §4.
LIBKWL_DIR="$REPO_ROOT/examples/libs/libkwl"
KWL_GEN="$REPO_ROOT/local-binaries/wlcompositor-gen"
if [ -d "$LIBKWL_DIR/src" ]; then
    if [ ! -f "$KWL_GEN/xdg-shell-client-protocol.h" ]; then
        echo "Error: $KWL_GEN/xdg-shell-client-protocol.h missing — the" >&2
        echo "wlcompositor build pass must run before libkwl." >&2
        exit 1
    fi
    echo "==> Building libkwl (Wayland toolkit)..."
    CC="$CC" AR="$LLVM_BIN/llvm-ar" XDG_SHELL_INCLUDE="$KWL_GEN" \
        bash "$LIBKWL_DIR/build.sh" "$SYSROOT"

    # libkwl clients: kwldemo (PR7 Phase 2 gate), wlclock (animated analog
    # clock), wlpaint (palette + pointer-drag painting). Link order:
    # dependents before deps — app + xdg glue, then libkwl (calls
    # wpk_*/wl_*/xkb_*), then libwpkdraw, then the wayland stack, libffi
    # last so wl_closure_invoke's ffi_call resolves.
    for kwl_app in kwldemo wlclock wlpaint; do
        [ -f "$REPO_ROOT/programs/$kwl_app.c" ] || continue
        kwl_app_wasm="$OUT_DIR_32/$kwl_app.wasm"
        echo "  Compiling $kwl_app (libkwl client)..."
        "$CC" "${CFLAGS[@]}" "-I$KWL_GEN" \
            "$REPO_ROOT/programs/$kwl_app.c" \
            "$KWL_GEN/xdg-shell-protocol.c" \
            "${LINK_PRE_LIBS[@]}" \
            "$SYSROOT/lib/libkwl.a" \
            "$SYSROOT/lib/libwpkdraw.a" \
            "$SYSROOT/lib/libwayland-client.a" \
            "$SYSROOT/lib/libxkbcommon.a" \
            "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
            "$SYSROOT/lib/libffi.a" \
            "${LINK_POST_LIBS[@]}" \
            -o "$kwl_app_wasm"
        "$FORK_INSTRUMENT" "$kwl_app_wasm" -o "$kwl_app_wasm.instr"
        mv "$kwl_app_wasm.instr" "$kwl_app_wasm"
    done
fi

# wlterm (PR7 Phase 3): a real terminal — a libkwl window + an in-tree VT100
# core (vt100.c) + a forkpty'd shell. Dedicated pass (like wlcompositor):
# multi-source link (wlterm.c + vt100.c + the generated xdg-shell glue) plus
# the libkwl/wpkdraw/wayland/xkb archives, and fork-instrumentation is
# MANDATORY because forkpty() forks (CLAUDE.md fork policy — must not
# silently degrade). Files live under programs/wlterm/ so the flat loop skips
# them. See docs/plans/2026-07-09-dri-pr7-libkwl-wlterm-plan.md §5.
if ls "$REPO_ROOT"/programs/wlterm/*.c >/dev/null 2>&1; then
    if [ ! -f "$SYSROOT/lib/libkwl.a" ]; then
        echo "Error: libkwl.a missing — the libkwl pass must run before wlterm." >&2
        exit 1
    fi
    echo "==> Building wlterm (libkwl terminal + VT100 + forkpty)..."
    wlterm_wasm="$OUT_DIR_32/wlterm.wasm"
    "$CC" "${CFLAGS[@]}" "-I$KWL_GEN" \
        "$REPO_ROOT/programs/wlterm/wlterm.c" \
        "$REPO_ROOT/programs/wlterm/vt100.c" \
        "$KWL_GEN/xdg-shell-protocol.c" \
        "${LINK_PRE_LIBS[@]}" \
        "$SYSROOT/lib/libkwl.a" \
        "$SYSROOT/lib/libwpkdraw.a" \
        "$SYSROOT/lib/libwayland-client.a" \
        "$SYSROOT/lib/libxkbcommon.a" \
        "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
        "$SYSROOT/lib/libffi.a" \
        "${LINK_POST_LIBS[@]}" \
        -o "$wlterm_wasm"
    # forkpty() forks — instrumentation is required, not optional.
    "$FORK_INSTRUMENT" "$wlterm_wasm" -o "$wlterm_wasm.instr"
    mv "$wlterm_wasm.instr" "$wlterm_wasm"
fi

for src in "$REPO_ROOT/programs/"*.cpp; do
    [ -f "$src" ] || continue
    build_cpp_program "$src" "$OUT_DIR_32"
done

# SDL2 playground app — every .c under programs/sdl2/ links into the
# single sdl2.wasm binary. Multi-source clang invocation: clang
# accepts the sources together with the libc/glue prelude and the
# full SDL2 + dependency archive set, then we run fork-instrument on
# the result. Link set: libSDL2 + libasound + libinput + libgbm +
# libdrm plus libEGL / libGLESv2 (the SDL_opengles2 header bundle
# transitively pulls <GLES2/gl2.h> but the per-file grep in
# build_program only catches direct top-level EGL/GLES includes).
if ls "$REPO_ROOT"/programs/sdl2/*.c >/dev/null 2>&1; then
    # Regenerate the Inconsolata TTF→C byte-array header if missing or
    # older than the .ttf. The .h is git-ignored; the .ttf is the
    # source of truth (see programs/sdl2/third_party/NOTICE.md).
    sdl2_ttf="$REPO_ROOT/programs/sdl2/third_party/Inconsolata-Regular.ttf"
    sdl2_ttf_h="$REPO_ROOT/programs/sdl2/third_party/inconsolata_ttf.h"
    if [ -f "$sdl2_ttf" ]; then
        if [ ! -f "$sdl2_ttf_h" ] || [ "$sdl2_ttf" -nt "$sdl2_ttf_h" ]; then
            echo "  Regenerating inconsolata_ttf.h from $(basename "$sdl2_ttf")..."
            python3 - "$sdl2_ttf" "$sdl2_ttf_h" <<'PY'
import sys, pathlib
src = pathlib.Path(sys.argv[1]).read_bytes()
dst = pathlib.Path(sys.argv[2])
# 16 bytes per line keeps each token whole and the file ~6× the .ttf
# size — well under what clang chokes on.
PER_LINE = 16
lines = [
    ",".join(f"0x{b:02x}" for b in src[i:i + PER_LINE])
    for i in range(0, len(src), PER_LINE)
]
dst.write_text(
    "/* Auto-generated from Inconsolata-Regular.ttf by "
    "scripts/build-programs.sh. */\n"
    "/* See programs/sdl2/third_party/NOTICE.md for license. */\n"
    "#pragma once\n"
    f"static const unsigned char inconsolata_ttf[] = {{\n"
    + ",\n".join(lines) + "\n};\n"
    f"static const unsigned int inconsolata_ttf_len = {len(src)};\n"
)
PY
        fi
    fi
    sdl2_sources=("$REPO_ROOT"/programs/sdl2/*.c)
    sdl2_wasm="$OUT_DIR_32/sdl2.wasm"
    echo "  Compiling sdl2 (multi-source: ${#sdl2_sources[@]} file(s))..."
    "$CC" "${CFLAGS[@]}" "${sdl2_sources[@]}" \
        "${LINK_PRE_LIBS[@]}" \
        "$SYSROOT/lib/libSDL2.a" \
        "$SYSROOT/lib/libasound.a" \
        "$SYSROOT/lib/libinput.a" \
        "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
        "$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a" \
        "${LINK_POST_LIBS[@]}" \
        -o "$sdl2_wasm"
    "$FORK_INSTRUMENT" "$sdl2_wasm" -o "$sdl2_wasm.instr"
    mv "$sdl2_wasm.instr" "$sdl2_wasm"
fi

echo "Building example programs..."
for src in "$REPO_ROOT/examples/"*.c; do
    [ -f "$src" ] || continue
    build_program "$src" "$REPO_ROOT/examples"
done

echo "Building benchmark programs..."
BENCH_OUT_DIR="$REPO_ROOT/benchmarks/wasm"
mkdir -p "$BENCH_OUT_DIR"
for src in "$REPO_ROOT/benchmarks/programs/"*.c; do
    [ -f "$src" ] || continue
    build_program "$src" "$BENCH_OUT_DIR"
done

# Build wasm64 programs if sysroot64 exists
SYSROOT64="$REPO_ROOT/sysroot64"
if [ -f "$SYSROOT64/lib/libc.a" ]; then
    echo "Building wasm64 programs..."

    CFLAGS64=(
        --target=wasm64-unknown-unknown
        --sysroot="$SYSROOT64"
        -nostdlib
        -O2
        -matomics -mbulk-memory
        -fno-trapping-math
        -mllvm -wasm-enable-sjlj
        -mllvm -wasm-use-legacy-eh=false
    )

    LINK_FLAGS64=(
        "$GLUE_DIR/channel_syscall.c"
        "$GLUE_DIR/compiler_rt.c"
        "$SYSROOT64/lib/crt1.o"
        "$SYSROOT64/lib/libc.a"
        -Wl,--entry=_start
        -Wl,--export=_start
        -Wl,--import-memory
        -Wl,--shared-memory
        -Wl,--max-memory=1073741824
        -Wl,--allow-undefined
        -Wl,--table-base=3
        -Wl,--export-table
        -Wl,--growable-table
        -Wl,--export=__wasm_init_tls
        -Wl,--export=__tls_base
        -Wl,--export=__tls_size
        -Wl,--export=__tls_align
        -Wl,--export=__stack_pointer
        -Wl,--export=__wasm_thread_init
    )

    for src in "$REPO_ROOT/programs/"hello64.c; do
        [ -f "$src" ] || continue
        local_name=$(basename "$src" .c)
        echo "  Compiling $local_name (wasm64)..."
        "$CC" "${CFLAGS64[@]}" "$src" "${LINK_FLAGS64[@]}" -o "$OUT_DIR_64/${local_name}.wasm"
    done
fi

echo "Programs built."
