#!/bin/bash
set -euo pipefail

# Build user programs (programs/*.c) into local-binaries/programs/.
# The resolver (host/src/binary-resolver.ts) prefers local-binaries/
# over binaries/, so locally-built binaries automatically override
# whatever the fetcher placed under `binaries/`.
# Compiles and links through this checkout's SDK drivers (sdk/bin/), the
# same way the conformance runners and user software build.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# WHY: the SDK resolves the sysroot and glue dir by walking up from the
# current directory -- findSysroot and findGlueDir, both through
# projectRootOrSdk/findProjectRoot in sdk/src/lib/toolchain.ts -- not from
# this script's location. Invoked with a cwd inside a different Kandelo
# checkout, it would silently compile against THAT checkout's sysroot while
# the prerequisite check below validated this one. Pin the cwd so both agree.
#
# Do not "fix" this by exporting WASM_POSIX_SYSROOT instead: findSysroot()
# returns that value before its arch-aware lookup, which would hand the
# wasm64 build the wasm32 sysroot.
cd "$REPO_ROOT"
SYSROOT="$REPO_ROOT/sysroot"
BROWSER_MEMORY64_FIXTURES_REPO_ROOT="$REPO_ROOT"
BROWSER_MEMORY64_FIXTURES_MANIFEST="$REPO_ROOT/scripts/browser-memory64-example-fixtures.txt"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/browser-memory64-example-fixtures.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"
# Per-arch output dirs match the layout the resolver's
# `place_binaries_symlinks` writes:
# binaries/programs/<arch>/ and local-binaries/programs/<arch>/.
# wasm32 and wasm64 builds share program names (e.g. hello64.wasm)
# so they MUST live in separate trees — a flat OUT_DIR would
# last-write-wins across arches.
OUT_DIR_32="$REPO_ROOT/local-binaries/programs/wasm32"
OUT_DIR_64="$REPO_ROOT/local-binaries/programs/wasm64"
TEST_FIXTURE_DIR="$REPO_ROOT/local-binaries/test-fixtures"
mkdir -p "$OUT_DIR_32" "$OUT_DIR_64" "$TEST_FIXTURE_DIR/wasm32"

# Package-owned resolver paths must never be populated by this developer/test
# compiler. A regular file at one of those paths has no immutable package
# generation identity, and later package materialization must correctly refuse
# to replace it. Derive the complete ownership set from the generated package
# projection so new package-owned programs cannot recreate that collision.
PROGRAM_PACKAGE_INDEX="$REPO_ROOT/packages/registry/program-packages.json"
if [ -L "$PROGRAM_PACKAGE_INDEX" ]; then
    echo "Error: program package ownership index must be a regular file, not a symlink: $PROGRAM_PACKAGE_INDEX" >&2
    exit 1
fi
if [ ! -f "$PROGRAM_PACKAGE_INDEX" ]; then
    # The index is a generated artifact (gitignored). build.sh / local-build
    # normally emit it first; regenerate it here so a standalone invocation
    # still derives the ownership set from an up-to-date projection.
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
        build-deps program-index \
        --source-repo-root "$REPO_ROOT" \
        "$REPO_ROOT/packages/registry" \
        "$PROGRAM_PACKAGE_INDEX"
fi
PACKAGE_OWNED_PROGRAM_MIRRORS="$(
    node - "$PROGRAM_PACKAGE_INDEX" <<'NODE'
const fs = require("node:fs");
const indexPath = process.argv[2];
const document = JSON.parse(fs.readFileSync(indexPath, "utf8"));
if (
  document.format !== "kandelo-program-packages-v2" ||
  document.packages === null ||
  typeof document.packages !== "object" ||
  Array.isArray(document.packages)
) {
  throw new Error(`Invalid program package ownership index: ${indexPath}`);
}
const claims = new Map();
for (const [packageName, entry] of Object.entries(document.packages)) {
  if (
    entry === null ||
    typeof entry !== "object" ||
    !Array.isArray(entry.arches) ||
    !Array.isArray(entry.members)
  ) {
    throw new Error(`Invalid program package projection for ${packageName}`);
  }
  for (const arch of entry.arches) {
    if (arch !== "wasm32" && arch !== "wasm64") {
      throw new Error(`Invalid program package architecture for ${packageName}`);
    }
    for (const member of entry.members) {
      if (
        member === null ||
        typeof member !== "object" ||
        typeof member.mirrorPath !== "string" ||
        member.mirrorPath.length === 0
      ) {
        throw new Error(`Invalid program package member for ${packageName}`);
      }
      const claim = `${arch}/${member.mirrorPath}`;
      const previous = claims.get(claim);
      if (previous !== undefined && previous !== packageName) {
        throw new Error(
          `Program mirror ${claim} is claimed by ${previous} and ${packageName}`,
        );
      }
      claims.set(claim, packageName);
    }
  }
}
process.stdout.write([...claims.keys()].sort().join("\n"));
NODE
)" || {
    echo "Error: could not derive package-owned program mirrors" >&2
    exit 1
}

package_owns_direct_program_path() {
    local arch="$1"
    local mirror="$2"
    [ -n "$PACKAGE_OWNED_PROGRAM_MIRRORS" ] &&
        grep -Fxq -- "$arch/$mirror" <<<"$PACKAGE_OWNED_PROGRAM_MIRRORS"
}

# A multi-output package publishes `<package>/<output>.wasm`, so the direct
# mirror above never matches it. The resolver rejects the flat path for such
# an output, which makes a local fixture at that path unreachable.
package_owns_program_output() {
    local arch="$1"
    local output="$2"
    [ -n "$PACKAGE_OWNED_PROGRAM_MIRRORS" ] &&
        awk -F/ -v arch="$arch" -v out="$output" \
            '$1 == arch && $NF == out { found = 1 } END { exit !found }' \
            <<<"$PACKAGE_OWNED_PROGRAM_MIRRORS"
}

find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ] && [ -x "$LLVM_BIN/clang" ]; then
        echo "$LLVM_BIN"
        return
    fi
    if [ -n "${LLVM_PREFIX:-}" ] && [ -x "$LLVM_PREFIX/bin/clang" ]; then
        echo "$LLVM_PREFIX/bin"
        return
    fi
    if command -v clang >/dev/null 2>&1; then
        dirname "$(command -v clang)"
        return
    fi
    echo "Error: LLVM/clang not found. Run scripts/dev-shell.sh or set LLVM_BIN/LLVM_PREFIX." >&2
    exit 1
}

# LLVM_BIN still serves the in-tree static-library builds below (libwpkdraw,
# libkwl), whose build.sh scripts take a raw CC/AR pair.
LLVM_BIN="$(find_llvm_bin)"

# The SDK owns the link contract. This script used to carry its own copy in
# LINK_PRE_LIBS/LINK_POST_LIBS, which drifted from sdk/src/lib/flags.ts: it
# lacked --export=__heap_base and --global-base, so every program it built
# was laid out differently from SDK-built software, and the host had to
# guess each program's heap base. CLAUDE.md requires build scripts to use
# the worktree-local SDK; one copy of a rule cannot disagree with itself.
#
# Absolute paths, never bare names: a bare `wasm32posix-c++` resolves through
# PATH and can pick up a different worktree's SDK.
#
# Deliberately NOT named CC/CXX. Those names are already exported in the dev
# shell, and bash keeps the export attribute when you assign to an exported
# name -- so `CC=.../wasm32posix-cc` would reach every child process,
# including the host `cargo run -p xtask` calls below, whose cc-rs build
# scripts would then try to compile host objects with a wasm cross-compiler.
WASM32_CC="$REPO_ROOT/sdk/bin/wasm32posix-cc"
WASM64_CC="$REPO_ROOT/sdk/bin/wasm64posix-cc"
WASM32_CXX="$REPO_ROOT/sdk/bin/wasm32posix-c++"
WASM64_CXX="$REPO_ROOT/sdk/bin/wasm64posix-c++"
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"

# Verify prerequisites
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi

# Everything the SDK already supplies is deliberately absent here. Its
# compileFlags() (sdk/src/lib/flags.ts) owns --target, -matomics,
# -mbulk-memory, -mexception-handling, -fno-trapping-math and the -mllvm SjLj
# / modern-EH pair; cc.ts adds --sysroot from the resolved toolchain; its
# executable link injects the syscall glue (channel_syscall.c, compiler_rt.c,
# cxxrt.c), crt1.o, the sysroot libc.a and linkFlags(). Per-program archives
# passed after the sources still land BEFORE libc.a: the SDK forwards caller
# inputs verbatim, in order, and appends libc.a after them, so the stubs'
# internal references (mmap, ioctl, calloc, ...) resolve in a single linker
# pass.
CFLAGS=(
    -O2
    # Upstream libdrm installs public headers under `include/libdrm/`
    # (matches the `--cflags` pkg-config flag). Programs `#include
    # <xf86drm.h>` from there. `include/drm/` is the UAPI dir that
    # xf86drm.h itself transitively pulls in via `#include <drm.h>`;
    # both dirs must be on the search path or the upstream header
    # fan-out doesn't resolve. Harmless when the dirs are absent.
    -I"$SYSROOT/include/libdrm"
    -I"$SYSROOT/include/drm"
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
    local name arch=""
    name=$(basename "$src" .c)
    local wasm="$out_dir/${name}.wasm"
    local raw_wasm="$out_dir/${name}.raw.wasm"
    local next_wasm="$out_dir/${name}.next.wasm"

    case "$out_dir" in
        "$OUT_DIR_32") arch=wasm32 ;;
        "$OUT_DIR_64") arch=wasm64 ;;
    esac
    if [ -n "$arch" ] &&
       package_owns_direct_program_path "$arch" "${name}.wasm"; then
        # WHY: this path is a package mirror, not a compiler output directory.
        # Its owning recipe will publish a generation-backed symlink through
        # build-deps when a consumer actually selects the package.
        if [ -L "$wasm" ]; then
            echo "  Keeping $name: package resolver already owns $arch/${name}.wasm"
            return 0
        fi
        if [ -e "$wasm" ]; then
            echo "Error: package-owned resolver mirror is already occupied: $wasm" >&2
            return 1
        fi
        echo "  Skipping $name: package resolver owns $arch/${name}.wasm"
        return 0
    fi
    if [ -n "$arch" ] && package_owns_program_output "$arch" "${name}.wasm"; then
        echo "  Skipping $name: a package publishes ${name}.wasm"
        return 0
    fi

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
    # WHY: a failed compile or instrumentation pass must not leave a raw or
    # stale-ABI module at the resolver-visible final path.
    rm -f "$wasm" "$raw_wasm" "$next_wasm"
    # Bash 3.2 (macOS system bash) under `set -u` treats expansion of
    # an empty array as unbound; the `${arr[@]+...}` guard suppresses
    # that when extra_libs is empty.
    "$WASM32_CC" "${CFLAGS[@]}" "$src" \
        ${extra_libs[@]+"${extra_libs[@]}"} \
        -o "$raw_wasm"

    # Apply fork instrumentation if the program can participate in fork. The
    # tool returns standalone executables without a fork or dynamic-loader
    # boundary byte-for-byte unchanged, so it is safe to run unconditionally.
    # Side modules and loader-capable mains still receive process-image state
    # helpers even when they have no local fork import.
    "$FORK_INSTRUMENT" "$raw_wasm" -o "$next_wasm"
    mv "$next_wasm" "$wasm"
    record_built_program_output "$wasm"
    rm -f "$raw_wasm"
}

# Build a C++ program via the SDK's wasm32posix-c++ wrapper. The SDK
# injects the toolchain's standard compile + link flags, the channel
# syscall glue, the C++ runtime stubs (cxxrt.c), and the sysroot path.
# libc++ comes from the resolved libcxx package (libcxx_flags), not from
# the sysroot.
build_cpp_program() {
    local src="$1"
    local out_dir="$2"
    local name
    name=$(basename "$src" .cpp)
    local wasm="$out_dir/${name}.wasm"
    local raw_wasm="$out_dir/${name}.raw.wasm"
    local next_wasm="$out_dir/${name}.next.wasm"

    echo "  Compiling $name (C++)..."
    rm -f "$wasm" "$raw_wasm" "$next_wasm"
    # -fwasm-exceptions is required for clang to lower C++ try/catch
    # to wasm-EH `try`/`catch` instructions. Without it clang emits
    # `__cxa_throw; unreachable` and DCEs the catch handlers, so the
    # whole exception-propagation chain (libunwind + libc++abi) never
    # runs.
    # shellcheck disable=SC2046
    "$WASM32_CXX" \
        -O2 \
        -fwasm-exceptions \
        $(libcxx_flags "$LIBCXX_PREFIX_32") \
        "$src" \
        -lc++ -lc++abi \
        -o "$raw_wasm"

    # Preserve a raw no-fork control for issue #918 independently of the
    # normally instrumented fork-bearing program.
    if [ "$name" = "sjlj_noexcept_boundary" ]; then
        mkdir -p "$TEST_FIXTURE_DIR/wasm32"
        # shellcheck disable=SC2046
        "$WASM32_CXX" \
            -O2 \
            -fwasm-exceptions \
            -DKANDELO_SJLJ_NO_FORK_ANCHOR \
            $(libcxx_flags "$LIBCXX_PREFIX_32") \
            "$src" \
            -lc++ -lc++abi \
            -o "$TEST_FIXTURE_DIR/wasm32/${name}.raw.wasm"
        record_built_program_output "$TEST_FIXTURE_DIR/wasm32/${name}.raw.wasm"
    fi

    # Publish the resolver-visible path only after instrumentation and its
    # complete ABI 43 artifact contract succeed.
    "$FORK_INSTRUMENT" "$raw_wasm" -o "$next_wasm"
    mv "$next_wasm" "$wasm"
    record_built_program_output "$wasm"
    rm -f "$raw_wasm"
}

# Copy one resolved artifact into the shared sysroot as a regular file.
#
# Never symlink it: kandelo_package_require_regular_input_tree rejects any
# private-sysroot seed that contains a symlink, so one symlink planted here
# fails every later package that seeds its private sysroot from this one
# (kandelo-sdk first). `rm -f` first matters too -- cp onto an existing
# symlink writes THROUGH it, into the resolver cache it points at. This is
# the same rm-then-cp shape the SDL2 staging uses.
stage_sysroot_file() {
    rm -f "$2"
    cp "$1" "$2"
}

stage_sysroot_tree() {
    rm -rf "$2"
    cp -RL "$1" "$2"
}

# Resolve libcxx and print its output directory. C++ programs compile and
# link against that directory directly. Copying it into the shared worktree
# sysroot made libc++'s presence there depend on build order
# (scripts/build-musl.sh recreates the sysroot without it), so a package
# build could silently find, or miss, whichever copy was left behind.
resolve_libcxx_prefix() {
    local arch="$1"
    echo "==> Resolving libcxx for $arch C++ programs..." >&2
    local host_triple
    host_triple="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$host_triple" --quiet -- \
        build-deps --arch "$arch" resolve libcxx >/dev/null)
    (cd "$REPO_ROOT" && cargo run -p xtask \
        --target "$host_triple" --quiet -- build-deps --arch "$arch" path libcxx)
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
    CC="$LLVM_BIN/clang" AR="$LLVM_BIN/llvm-ar" bash "$WPKDRAW_DIR/build.sh" "$SYSROOT"
fi

# Compile and link flags that take libc++ from a resolved libcxx directory:
# -nostdinc++ drops the sysroot's C++ header search so only the resolved,
# version-matched headers are visible.
libcxx_flags() {
    local prefix="$1"
    printf '%s\n' -nostdinc++ -isystem "$prefix/include/c++/v1" -L"$prefix/lib"
}

LIBCXX_PREFIX_32=""
if ls "$REPO_ROOT/programs/"*.cpp >/dev/null 2>&1; then
    LIBCXX_PREFIX_32="$(resolve_libcxx_prefix wasm32)"
fi

# Resolve SDL2 and stage it in the sysroot when there are SDL2 programs to
# build. Re-resolved on every run rather than guarded on libSDL2.a: SDL2
# depends on libdrm, whose cache directory moves when its build.toml
# revision bumps, and a guarded fast path would leave the staged headers
# and archive pointing at the pre-bump cache. The resolver is cached, so
# repeating it is cheap.
if ls "$REPO_ROOT"/programs/sdl2_*.c >/dev/null 2>&1 \
        || ls "$REPO_ROOT"/programs/sdl2/*.c >/dev/null 2>&1; then
    echo "==> Resolving sdl2 for SDL2 programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- \
        build-deps resolve sdl2 >/dev/null)
    SDL2_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask \
        --target "$HOST_TRIPLE" --quiet -- build-deps path sdl2)"
    cp "$SDL2_PREFIX/lib/libSDL2.a" "$SYSROOT/lib/libSDL2.a"
    rm -rf "$SYSROOT/include/SDL2"
    cp -R "$SDL2_PREFIX/include/SDL2" "$SYSROOT/include/SDL2"
fi

# Resolve libwayland (+ its deps libffi + wayland-protocols) and copy
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

    stage_sysroot_file "$LIBWL_PREFIX/lib/libwayland-client.a" "$SYSROOT/lib/libwayland-client.a"
    stage_sysroot_file "$LIBWL_PREFIX/lib/libwayland-server.a" "$SYSROOT/lib/libwayland-server.a"
    stage_sysroot_file "$LIBFFI_PREFIX/lib/libffi.a"           "$SYSROOT/lib/libffi.a"

    for h in "$LIBWL_PREFIX/include"/wayland-*.h; do
        stage_sysroot_file "$h" "$SYSROOT/include/$(basename "$h")"
    done
fi

# Resolve libffi and copy its archive + header into the sysroot when
# there are any libffi_*.c programs to build (the PR20 full-port matrix
# includes <ffi.h> directly; the libwayland block above only stages the
# archive). Same cached-resolve contract.
if ls "$REPO_ROOT"/programs/libffi_*.c >/dev/null 2>&1; then
    echo "==> Resolving libffi for FFI programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libffi >/dev/null)
    LIBFFI_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libffi)"

    stage_sysroot_file "$LIBFFI_PREFIX/lib/libffi.a"  "$SYSROOT/lib/libffi.a"
    stage_sysroot_file "$LIBFFI_PREFIX/include/ffi.h" "$SYSROOT/include/ffi.h"
fi

# Resolve glib (+ its deps libffi + zlib) and copy its archives +
# header tree into the sysroot when there are any glib_*.c programs to
# build (the PR21 smoke links gio/gobject/gmodule/glib). Same
# cached-resolve contract. The include tree keeps its glib-2.0/ prefix;
# the program case entry passes -I$SYSROOT/include/glib-2.0.
if ls "$REPO_ROOT"/programs/glib_*.c >/dev/null 2>&1; then
    echo "==> Resolving glib (and deps) for glib programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve glib >/dev/null)
    GLIB_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path glib)"
    LIBFFI_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libffi)"
    ZLIB_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path zlib)"
    PCRE2_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path pcre2)"

    for a in libglib-2.0.a libgmodule-2.0.a libgobject-2.0.a libgio-2.0.a; do
        stage_sysroot_file "$GLIB_PREFIX/lib/$a" "$SYSROOT/lib/$a"
    done
    stage_sysroot_file "$LIBFFI_PREFIX/lib/libffi.a"    "$SYSROOT/lib/libffi.a"
    stage_sysroot_file "$ZLIB_PREFIX/lib/libz.a"        "$SYSROOT/lib/libz.a"
    stage_sysroot_file "$PCRE2_PREFIX/lib/libpcre2-8.a" "$SYSROOT/lib/libpcre2-8.a"
    stage_sysroot_tree "$GLIB_PREFIX/include/glib-2.0"  "$SYSROOT/include/glib-2.0"
fi

# Resolve libxkbcommon and copy its archive + public headers into the
# sysroot when there are any xkb_*.c programs to build. Same cached-resolve
# contract as the libwayland block above. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md (PR4).
if ls "$REPO_ROOT"/programs/xkb_*.c >/dev/null 2>&1; then
    echo "==> Resolving libxkbcommon for XKB programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libxkbcommon >/dev/null)
    LIBXKB_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libxkbcommon)"

    stage_sysroot_file "$LIBXKB_PREFIX/lib/libxkbcommon.a" "$SYSROOT/lib/libxkbcommon.a"
    mkdir -p "$SYSROOT/include/xkbcommon"
    for h in "$LIBXKB_PREFIX/include/xkbcommon"/*.h; do
        stage_sysroot_file "$h" "$SYSROOT/include/xkbcommon/$(basename "$h")"
    done
fi

# Resolve pixman + utf8proc and copy their archives + headers into the
# sysroot when their smoke programs are present. Same cached-resolve
# contract as the libxkbcommon block above. First rungs of the PR19 font
# stack (freetype/fontconfig/fcft build on them). See
# docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md §4.
if ls "$REPO_ROOT"/programs/pixman_*.c >/dev/null 2>&1; then
    echo "==> Resolving pixman for pixman programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve pixman >/dev/null)
    PIXMAN_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path pixman)"

    stage_sysroot_file "$PIXMAN_PREFIX/lib/libpixman-1.a" "$SYSROOT/lib/libpixman-1.a"
    # Flat header copies: pixman.h angle-includes pixman-version.h, so
    # both must sit on the default include path (build_program adds no -I).
    for h in "$PIXMAN_PREFIX/include/pixman-1"/*.h; do
        stage_sysroot_file "$h" "$SYSROOT/include/$(basename "$h")"
    done
fi

if ls "$REPO_ROOT"/programs/utf8proc_*.c >/dev/null 2>&1; then
    echo "==> Resolving utf8proc for utf8proc programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve utf8proc >/dev/null)
    UTF8PROC_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path utf8proc)"

    stage_sysroot_file "$UTF8PROC_PREFIX/lib/libutf8proc.a"  "$SYSROOT/lib/libutf8proc.a"
    stage_sysroot_file "$UTF8PROC_PREFIX/include/utf8proc.h" "$SYSROOT/include/utf8proc.h"
fi

# Resolve the rest of the font stack (fcft → fontconfig + freetype, plus
# their libxml2/zlib link deps) when the fontstack smoke is present. fcft
# and fontconfig headers keep their subdirs; freetype is include-path-only
# via fcft, so only its archive is copied.
if ls "$REPO_ROOT"/programs/fontstack_*.c >/dev/null 2>&1; then
    echo "==> Resolving fcft + fontconfig + freetype for font-stack programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    # libiconv is a link dependency of libxml2 (it converts encodings
    # through GNU libiconv). It is linked from its resolved prefix rather
    # than staged: a libiconv in the sysroot would shadow libc's iconv for
    # every other program.
    for pkg in fcft fontconfig freetype libxml2 libiconv zlib; do
        (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve "$pkg" >/dev/null)
    done
    LIBICONV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libiconv)"
    FCFT_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path fcft)"
    FONTCONFIG_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path fontconfig)"
    FREETYPE_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path freetype)"
    LIBXML2_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libxml2)"
    ZLIB_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path zlib)"

    stage_sysroot_tree "$FCFT_PREFIX/include/fcft"              "$SYSROOT/include/fcft"
    stage_sysroot_file "$FCFT_PREFIX/lib/libfcft.a"             "$SYSROOT/lib/libfcft.a"
    stage_sysroot_file "$FONTCONFIG_PREFIX/lib/libfontconfig.a" "$SYSROOT/lib/libfontconfig.a"
    stage_sysroot_file "$FREETYPE_PREFIX/lib/libfreetype.a"     "$SYSROOT/lib/libfreetype.a"
    stage_sysroot_file "$LIBXML2_PREFIX/lib/libxml2.a"          "$SYSROOT/lib/libxml2.a"
    stage_sysroot_file "$ZLIB_PREFIX/lib/libz.a"                "$SYSROOT/lib/libz.a"
fi

# Resolve the PR23 render stack (pango → cairo + harfbuzz + fribidi on
# the glib and font-stack prefixes) when the pango smoke is present.
# Same cached-resolve contract. Header trees keep their upstream
# prefixes; the case entry passes the -I flags. See
# docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md §4.
if ls "$REPO_ROOT"/programs/pango_*.c >/dev/null 2>&1; then
    echo "==> Resolving pango (and deps) for pango programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve pango >/dev/null)
    PANGO_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path pango)"
    CAIRO_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path cairo)"
    HARFBUZZ_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path harfbuzz)"
    FRIBIDI_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path fribidi)"
    LIBPNG_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libpng)"
    PIXMAN_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path pixman)"
    FONTCONFIG_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path fontconfig)"
    FREETYPE_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path freetype)"
    LIBXML2_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libxml2)"
    ZLIB_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path zlib)"
    # libxml2's libiconv, linked from its prefix (see the font-stack block).
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libiconv >/dev/null)
    LIBICONV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libiconv)"

    for a in libpango-1.0.a libpangoft2-1.0.a libpangocairo-1.0.a; do
        stage_sysroot_file "$PANGO_PREFIX/lib/$a" "$SYSROOT/lib/$a"
    done
    stage_sysroot_file "$CAIRO_PREFIX/lib/libcairo.a"           "$SYSROOT/lib/libcairo.a"
    stage_sysroot_file "$HARFBUZZ_PREFIX/lib/libharfbuzz.a"     "$SYSROOT/lib/libharfbuzz.a"
    stage_sysroot_file "$FRIBIDI_PREFIX/lib/libfribidi.a"       "$SYSROOT/lib/libfribidi.a"
    stage_sysroot_file "$LIBPNG_PREFIX/lib/libpng.a"            "$SYSROOT/lib/libpng.a"
    stage_sysroot_file "$PIXMAN_PREFIX/lib/libpixman-1.a"       "$SYSROOT/lib/libpixman-1.a"
    stage_sysroot_file "$FONTCONFIG_PREFIX/lib/libfontconfig.a" "$SYSROOT/lib/libfontconfig.a"
    stage_sysroot_file "$FREETYPE_PREFIX/lib/libfreetype.a"     "$SYSROOT/lib/libfreetype.a"
    stage_sysroot_file "$LIBXML2_PREFIX/lib/libxml2.a"          "$SYSROOT/lib/libxml2.a"
    stage_sysroot_file "$ZLIB_PREFIX/lib/libz.a"                "$SYSROOT/lib/libz.a"
    stage_sysroot_tree "$PANGO_PREFIX/include/pango-1.0"        "$SYSROOT/include/pango-1.0"
    stage_sysroot_tree "$HARFBUZZ_PREFIX/include/harfbuzz"      "$SYSROOT/include/harfbuzz"
    stage_sysroot_tree "$CAIRO_PREFIX/include/cairo"            "$SYSROOT/include/cairo"
fi

# Resolve GTK3 (the PR24 stack: gdk-pixbuf + atk + libepoxy over the
# PR23 render stack and the wayland client libs) when a gtk3 smoke is
# present. Same cached-resolve contract. The render-stack copies come
# from the pango block above; this block adds the GTK-only layers. See
# docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md §4 (PR24).
if ls "$REPO_ROOT"/programs/gtk3_*.c >/dev/null 2>&1; then
    echo "==> Resolving gtk3 (and deps) for gtk3 programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve gtk3 >/dev/null)
    GTK3_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path gtk3)"
    ATK_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path atk)"
    GDK_PIXBUF_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path gdk-pixbuf)"
    LIBEPOXY_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libepoxy)"
    CAIRO_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path cairo)"
    LIBWL_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libwayland)"

    stage_sysroot_file "$GTK3_PREFIX/lib/libgtk-3.a"                "$SYSROOT/lib/libgtk-3.a"
    stage_sysroot_file "$GTK3_PREFIX/lib/libgdk-3.a"                "$SYSROOT/lib/libgdk-3.a"
    stage_sysroot_file "$ATK_PREFIX/lib/libatk-1.0.a"               "$SYSROOT/lib/libatk-1.0.a"
    stage_sysroot_file "$GDK_PIXBUF_PREFIX/lib/libgdk_pixbuf-2.0.a" "$SYSROOT/lib/libgdk_pixbuf-2.0.a"
    stage_sysroot_file "$LIBEPOXY_PREFIX/lib/libepoxy.a"            "$SYSROOT/lib/libepoxy.a"
    stage_sysroot_file "$CAIRO_PREFIX/lib/libcairo-gobject.a"       "$SYSROOT/lib/libcairo-gobject.a"
    stage_sysroot_file "$LIBWL_PREFIX/lib/libwayland-cursor.a"      "$SYSROOT/lib/libwayland-cursor.a"
    stage_sysroot_file "$LIBWL_PREFIX/lib/libwayland-egl.a"         "$SYSROOT/lib/libwayland-egl.a"
    stage_sysroot_tree "$GTK3_PREFIX/include/gtk-3.0"               "$SYSROOT/include/gtk-3.0"
    stage_sysroot_tree "$ATK_PREFIX/include/atk-1.0"                "$SYSROOT/include/atk-1.0"
    stage_sysroot_tree "$GDK_PIXBUF_PREFIX/include/gdk-pixbuf-2.0"  "$SYSROOT/include/gdk-pixbuf-2.0"
    stage_sysroot_tree "$LIBEPOXY_PREFIX/include/epoxy"             "$SYSROOT/include/epoxy"
fi

# Resolve libevdev and copy its archive + public header into the sysroot
# when there are any libevdev_*.c programs to build. Same cached-resolve
# contract as the libwayland/libxkbcommon blocks above. libevdev is the
# foundation of the real libinput port (PR5). See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5).
if ls "$REPO_ROOT"/programs/libevdev_*.c >/dev/null 2>&1; then
    echo "==> Resolving libevdev for evdev programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libevdev >/dev/null)
    LIBEVDEV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libevdev)"

    stage_sysroot_file "$LIBEVDEV_PREFIX/lib/libevdev.a" "$SYSROOT/lib/libevdev.a"
    mkdir -p "$SYSROOT/include/libevdev"
    stage_sysroot_file "$LIBEVDEV_PREFIX/include/libevdev/libevdev.h" "$SYSROOT/include/libevdev/libevdev.h"
fi

# Resolve mtdev and copy its archive + headers into the sysroot when
# there are any mtdev_*.c programs to build. mtdev is the link-only
# multitouch dependency of the real libinput port (PR5). Same
# cached-resolve contract as the blocks above. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5b).
if ls "$REPO_ROOT"/programs/mtdev_*.c >/dev/null 2>&1; then
    echo "==> Resolving mtdev for mtdev programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve mtdev >/dev/null)
    MTDEV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path mtdev)"

    stage_sysroot_file "$MTDEV_PREFIX/lib/libmtdev.a" "$SYSROOT/lib/libmtdev.a"
    stage_sysroot_file "$MTDEV_PREFIX/include/mtdev.h" "$SYSROOT/include/mtdev.h"
    stage_sysroot_file "$MTDEV_PREFIX/include/mtdev-plumbing.h" "$SYSROOT/include/mtdev-plumbing.h"
fi

# Resolve libudev and copy its archive + header into the sysroot when
# there are any libudev_*.c programs to build. libudev is the input_id
# classification shim the real libinput port (PR5) needs to accept
# devices. Same cached-resolve contract as the blocks above. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5b).
if ls "$REPO_ROOT"/programs/libudev_*.c >/dev/null 2>&1; then
    echo "==> Resolving libudev for libudev programs..."
    HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libudev >/dev/null)
    LIBUDEV_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libudev)"

    stage_sysroot_file "$LIBUDEV_PREFIX/lib/libudev.a" "$SYSROOT/lib/libudev.a"
    stage_sysroot_file "$LIBUDEV_PREFIX/include/libudev.h" "$SYSROOT/include/libudev.h"
fi

# Resolve libinput (real 1.25.0) for the libinput smoke. This is the real
# path-backend library the Wayland compositor will use (PR5c). The smoke is
# built in a dedicated pass after the program loop (build_program can't add
# the real header's -I), and links the real archive from its cache prefix by
# full path — deliberately NOT via a $SYSROOT/lib/libinput.a copy — so the
# sysroot carries no libinput identity. Its deps
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
        login.c|sudo-lite.c)
            # Package recipes own the image artifacts. Keep ordinary local
            # copies only as runtime test fixtures.
            build_program "$src" "$TEST_FIXTURE_DIR/wasm32"
            ;;
        modeset.c|dri-modeset.c|dumb_roundtrip.c|gbm_surface_smoke.c)
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
        kwldemo.c|wlclock.c|wlpaint.c|kbar.c|klauncher.c|knotify.c)
            # Link libkwl — built in a dedicated pass after the
            # wlcompositor block (which resolves the wayland/xkb archives and
            # generates the xdg-shell client header libkwl needs). Skip here.
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
        libffi_full_test.c)
            # PR20 matrix: ffi_call classification + closure trampoline
            # pool against the full libffi port.
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libffi.a"
            ;;
        glib_gdbus_smoke.c)
            # PR22: gdbus client core against the dbus-daemon port —
            # name owning, object export, method call round trips.
            build_program "$src" "$OUT_DIR_32" \
                "-I$SYSROOT/include/glib-2.0" \
                "$SYSROOT/lib/libgio-2.0.a" \
                "$SYSROOT/lib/libgobject-2.0.a" \
                "$SYSROOT/lib/libgmodule-2.0.a" \
                "$SYSROOT/lib/libglib-2.0.a" \
                "$SYSROOT/lib/libpcre2-8.a" \
                "$SYSROOT/lib/libffi.a" \
                "$SYSROOT/lib/libz.a"
            ;;
        notify-send.c)
            # The omarchy demo's notification sender: one Notify over the
            # session bus to the daemon owning org.freedesktop.Notifications
            # (mako). Same glib stack as the gdbus smoke.
            build_program "$src" "$OUT_DIR_32" \
                "-I$SYSROOT/include/glib-2.0" \
                "$SYSROOT/lib/libgio-2.0.a" \
                "$SYSROOT/lib/libgobject-2.0.a" \
                "$SYSROOT/lib/libgmodule-2.0.a" \
                "$SYSROOT/lib/libglib-2.0.a" \
                "$SYSROOT/lib/libpcre2-8.a" \
                "$SYSROOT/lib/libffi.a" \
                "$SYSROOT/lib/libz.a"
            ;;
        glib_smoke_test.c)
            # PR21: mainloop + gobject signals (libffi generic
            # marshaller) + gspawn against the glib port. Link order:
            # gio pulls gobject/gmodule/glib, gobject pulls libffi,
            # gio pulls libz.
            build_program "$src" "$OUT_DIR_32" \
                "-I$SYSROOT/include/glib-2.0" \
                "$SYSROOT/lib/libgio-2.0.a" \
                "$SYSROOT/lib/libgobject-2.0.a" \
                "$SYSROOT/lib/libgmodule-2.0.a" \
                "$SYSROOT/lib/libglib-2.0.a" \
                "$SYSROOT/lib/libpcre2-8.a" \
                "$SYSROOT/lib/libffi.a" \
                "$SYSROOT/lib/libz.a"
            ;;
        xkb_smoke.c)
            # Keymap compile + state translation against the libxkbcommon port.
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libxkbcommon.a"
            ;;
        pixman_smoke.c)
            # Fill + OP_OVER composite against the pixman port (PR19).
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libpixman-1.a"
            ;;
        utf8proc_smoke.c)
            # NFC + case map + grapheme break against the utf8proc port (PR19).
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libutf8proc.a"
            ;;
        pango_cairo_smoke.c)
            # PR23: pango layout + harfbuzz shaping + cairo image
            # surface render through the whole PR19 font stack. Link
            # order: pangocairo pulls pangoft2/pango/cairo, pango
            # pulls harfbuzz/fribidi/gio/gobject/glib (PangoFontMap is
            # a GListModel), cairo pulls
            # pixman/fontconfig/freetype/png, harfbuzz (C++) pulls
            # libc++.
            build_program "$src" "$OUT_DIR_32" \
                "-I$SYSROOT/include/pango-1.0" \
                "-I$SYSROOT/include/harfbuzz" \
                "-I$SYSROOT/include/glib-2.0" \
                "-I$SYSROOT/include/cairo" \
                "$SYSROOT/lib/libpangocairo-1.0.a" \
                "$SYSROOT/lib/libpangoft2-1.0.a" \
                "$SYSROOT/lib/libpango-1.0.a" \
                "$SYSROOT/lib/libcairo.a" \
                "$SYSROOT/lib/libharfbuzz.a" \
                "$SYSROOT/lib/libfribidi.a" \
                "$SYSROOT/lib/libgio-2.0.a" \
                "$SYSROOT/lib/libgobject-2.0.a" \
                "$SYSROOT/lib/libgmodule-2.0.a" \
                "$SYSROOT/lib/libglib-2.0.a" \
                "$SYSROOT/lib/libpcre2-8.a" \
                "$SYSROOT/lib/libffi.a" \
                "$SYSROOT/lib/libpixman-1.a" \
                "$SYSROOT/lib/libfontconfig.a" \
                "$SYSROOT/lib/libfreetype.a" \
                "$SYSROOT/lib/libxml2.a" \
                "$LIBICONV_PREFIX/lib/libiconv.a" \
                "$SYSROOT/lib/libpng.a" \
                "$SYSROOT/lib/libz.a" \
                "$LIBCXX_PREFIX_32/lib/libc++.a" \
                "$LIBCXX_PREFIX_32/lib/libc++abi.a"
            ;;
        gtk3_smoke.c)
            # PR24: unmodified GTK3 wayland client — window + label
            # through gdk-wayland, pango shaping, cairo wl_shm render.
            # Link order: gtk pulls gdk/atk/gdk-pixbuf/epoxy, gdk pulls
            # the wayland client libs + xkbcommon + cairo-gobject, then
            # the PR23 render closure, glib stack, and font stack.
            # libgbm/libdrm back gdk's wl_shm pools (see the gtk3
            # package's wayland-shm-gbm-pool.patch); libEGL and libGLESv2
            # back libwayland-egl.
            build_program "$src" "$OUT_DIR_32" \
                "-I$SYSROOT/include/gtk-3.0" \
                "-I$SYSROOT/include/atk-1.0" \
                "-I$SYSROOT/include/gdk-pixbuf-2.0" \
                "-I$SYSROOT/include/pango-1.0" \
                "-I$SYSROOT/include/harfbuzz" \
                "-I$SYSROOT/include/glib-2.0" \
                "-I$SYSROOT/include/cairo" \
                "$SYSROOT/lib/libgtk-3.a" \
                "$SYSROOT/lib/libgdk-3.a" \
                "$SYSROOT/lib/libatk-1.0.a" \
                "$SYSROOT/lib/libgdk_pixbuf-2.0.a" \
                "$SYSROOT/lib/libepoxy.a" \
                "$SYSROOT/lib/libwayland-client.a" \
                "$SYSROOT/lib/libwayland-cursor.a" \
                "$SYSROOT/lib/libwayland-egl.a" \
                "$SYSROOT/lib/libxkbcommon.a" \
                "$SYSROOT/lib/libpangocairo-1.0.a" \
                "$SYSROOT/lib/libpangoft2-1.0.a" \
                "$SYSROOT/lib/libpango-1.0.a" \
                "$SYSROOT/lib/libcairo-gobject.a" \
                "$SYSROOT/lib/libcairo.a" \
                "$SYSROOT/lib/libharfbuzz.a" \
                "$SYSROOT/lib/libfribidi.a" \
                "$SYSROOT/lib/libgio-2.0.a" \
                "$SYSROOT/lib/libgobject-2.0.a" \
                "$SYSROOT/lib/libgmodule-2.0.a" \
                "$SYSROOT/lib/libglib-2.0.a" \
                "$SYSROOT/lib/libpcre2-8.a" \
                "$SYSROOT/lib/libffi.a" \
                "$SYSROOT/lib/libpixman-1.a" \
                "$SYSROOT/lib/libfontconfig.a" \
                "$SYSROOT/lib/libfreetype.a" \
                "$SYSROOT/lib/libxml2.a" \
                "$LIBICONV_PREFIX/lib/libiconv.a" \
                "$SYSROOT/lib/libpng.a" \
                "$SYSROOT/lib/libz.a" \
                "$SYSROOT/lib/libgbm.a" \
                "$SYSROOT/lib/libdrm.a" \
                "$SYSROOT/lib/libEGL.a" \
                "$SYSROOT/lib/libGLESv2.a" \
                "$LIBCXX_PREFIX_32/lib/libc++.a" \
                "$LIBCXX_PREFIX_32/lib/libc++abi.a"
            ;;
        fontstack_smoke.c)
            # monospace resolve + glyph rasterization through the whole
            # freetype/fontconfig/fcft/pixman stack (PR19).
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libfcft.a" \
                "$SYSROOT/lib/libfontconfig.a" \
                "$SYSROOT/lib/libfreetype.a" \
                "$SYSROOT/lib/libxml2.a" \
                "$LIBICONV_PREFIX/lib/libiconv.a" \
                "$SYSROOT/lib/libpixman-1.a" \
                "$SYSROOT/lib/libz.a"
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
            # dep set resolved from the package cache). Skip here.
            ;;
        sdl2_*.c)
            # SDL2's KMSDRM backend calls into gbm, libdrm and — through
            # SDL_egl.c's SDL_VIDEO_STATIC_ANGLE path — EGL/GLES2, so all
            # four follow libSDL2.a in the link order. build_program's
            # header-based auto-detection cannot see the EGL dependency:
            # these fixtures include only SDL headers, and without the
            # explicit archives every eglFoo SDL2 references becomes an
            # `env.*` import that traps the first time a window is made.
            #
            # libwayland-client + libffi: SDL2 is built with
            # `--enable-video-wayland --disable-wayland-shared`, so libSDL2.a's
            # video bootstrap array lists Wayland_bootstrap BEFORE
            # KMSDRM_bootstrap and direct-references wl_display_connect (no
            # dlopen). SDL_Init(VIDEO) probes Wayland first: the real
            # wl_display_connect(NULL) returns NULL when no compositor is
            # running, so SDL falls through to KMSDRM, as on real hardware.
            # libffi backs libwayland-client's wl_closure marshalling. The
            # Wayland backend also calls libwayland-egl, libwayland-cursor
            # and libxkbcommon (the sdl2-demo package links the same set).
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libSDL2.a" \
                "$SYSROOT/lib/libwayland-client.a" \
                "$SYSROOT/lib/libwayland-egl.a" \
                "$SYSROOT/lib/libwayland-cursor.a" \
                "$SYSROOT/lib/libxkbcommon.a" \
                "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
                "$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a" \
                "$SYSROOT/lib/libffi.a"
            ;;
        f_01_ucontext_get.c|f_02_ucontext_makeswap.c)
            # ucontext (getcontext/makecontext/swapcontext/setcontext) is a
            # documented unsupported API (docs/posix-status.md), and libc has
            # no such symbols. Since ABI 46 links are honest, so the boundary
            # shows up where it belongs: these fixtures must FAIL to link on
            # exactly those symbols. If one ever links, revisit the boundary.
            local_log="$(mktemp)"
            if "$WASM32_CC" "${CFLAGS[@]}" "$src" \
                    -o "$(mktemp -d)/ucontext.wasm" >"$local_log" 2>&1; then
                echo "Error: $(basename "$src") linked, but ucontext is documented as unsupported" >&2
                rm -f "$local_log"; exit 1
            fi
            if ! grep -qE 'undefined symbol: (getcontext|makecontext|swapcontext|setcontext)$' "$local_log"; then
                echo "Error: $(basename "$src") failed to link for an unexpected reason:" >&2
                cat "$local_log" >&2; rm -f "$local_log"; exit 1
            fi
            rm -f "$local_log"
            echo "  $(basename "$src" .c): does not link (ucontext unsupported) — as expected"
            ;;
        posix-timer-thread.c)
            # Keep the fixture's pthread capacity small so its timer-helper
            # churn test proves detached helpers are actually reclaimed.
            build_program "$src" "$OUT_DIR_32" \
                --kandelo-thread-slots 8
            ;;
        *)
            build_program "$src" "$OUT_DIR_32"
            ;;
    esac
done

# libinput smoke — real libinput 1.25.0. Dedicated compile/link (not
# build_program): it needs the real <libinput.h> from the resolved prefix,
# kept off the sysroot. Link order: dependents before dependencies (libinput →
# libevdev / libudev / mtdev → libc). See PR5c.
if [ -n "$LIBINPUT_REAL_PREFIX" ] && [ -f "$REPO_ROOT/programs/libinput_smoke.c" ]; then
    libinput_wasm="$OUT_DIR_32/libinput_smoke.wasm"
    echo "  Compiling libinput_smoke (real libinput 1.25.0)..."
    "$WASM32_CC" "${CFLAGS[@]}" "-I$LIBINPUT_REAL_PREFIX/include" \
        "$REPO_ROOT/programs/libinput_smoke.c" \
        "$LIBINPUT_REAL_PREFIX/lib/libinput.a" \
        "$LIBINPUT_LIBEVDEV_PREFIX/lib/libevdev.a" \
        "$LIBINPUT_LIBUDEV_PREFIX/lib/libudev.a" \
        "$LIBINPUT_MTDEV_PREFIX/lib/libmtdev.a" \
        -o "$libinput_wasm"
    "$FORK_INSTRUMENT" "$libinput_wasm" -o "$libinput_wasm.instr"
    mv "$libinput_wasm.instr" "$libinput_wasm"
    record_built_program_output "$libinput_wasm"
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

    # Public headers on the sysroot include path (idempotent — the wl_*/xkb_*
    # blocks above copy the same paths; the archives too).
    for h in "$WLC_LIBWL/include"/wayland-*.h; do
        stage_sysroot_file "$h" "$SYSROOT/include/$(basename "$h")"
    done
    stage_sysroot_file "$WLC_LIBFFI/lib/libffi.a"            "$SYSROOT/lib/libffi.a"
    stage_sysroot_file "$WLC_LIBWL/lib/libwayland-server.a"  "$SYSROOT/lib/libwayland-server.a"
    stage_sysroot_file "$WLC_LIBWL/lib/libwayland-client.a"  "$SYSROOT/lib/libwayland-client.a"
    stage_sysroot_file "$WLC_LIBWL/lib/libwayland-cursor.a"  "$SYSROOT/lib/libwayland-cursor.a"
    stage_sysroot_file "$WLC_LIBXKB/lib/libxkbcommon.a"      "$SYSROOT/lib/libxkbcommon.a"
    mkdir -p "$SYSROOT/include/xkbcommon"
    for h in "$WLC_LIBXKB/include/xkbcommon"/*.h; do
        stage_sysroot_file "$h" "$SYSROOT/include/xkbcommon/$(basename "$h")"
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

    # Same for zxdg_decoration_manager_v1 (PR14e): server-side decoration
    # negotiation. The compositor forces SERVER_SIDE so tiled clients drop CSD;
    # the client header + private-code drive wlclient-test's decoration request.
    DECOR_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/xdg-decoration-unstable-v1.xml"
    wayland-scanner private-code  "$DECOR_XML" "$WLC_GEN/xdg-decoration-v1-protocol.c"
    wayland-scanner server-header "$DECOR_XML" "$WLC_GEN/xdg-decoration-v1-server-protocol.h"
    wayland-scanner client-header "$DECOR_XML" "$WLC_GEN/xdg-decoration-v1-client-protocol.h"

    # Same for zwlr_layer_shell_v1 (PR15): the shell-component protocol. The
    # compositor anchors bars/launchers with it; kbar + klauncher are its
    # clients, and it is what upstream Waybar/mako speak too.
    LAYER_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/wlr-layer-shell-unstable-v1.xml"
    wayland-scanner private-code  "$LAYER_XML" "$WLC_GEN/wlr-layer-shell-v1-protocol.c"
    wayland-scanner server-header "$LAYER_XML" "$WLC_GEN/wlr-layer-shell-v1-server-protocol.h"
    wayland-scanner client-header "$LAYER_XML" "$WLC_GEN/wlr-layer-shell-v1-client-protocol.h"

    # Same for wp_presentation (PR19): frame-timing feedback off the existing
    # PAGE_FLIP timestamps. foot uses it for frame pacing; clients without it
    # fall back to wl_surface.frame.
    PTIME_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/presentation-time.xml"
    wayland-scanner private-code  "$PTIME_XML" "$WLC_GEN/presentation-time-protocol.c"
    wayland-scanner server-header "$PTIME_XML" "$WLC_GEN/presentation-time-server-protocol.h"
    wayland-scanner client-header "$PTIME_XML" "$WLC_GEN/presentation-time-client-protocol.h"

    # Same for zxdg_output_manager_v1 + wp_viewporter +
    # wp_fractional_scale_manager_v1 (PR24): the logical-output geometry and
    # crop/scale surface GTK3, Waybar and mako query. The compositor answers
    # with the fixed scale-1 fullscreen output.
    XDGOUT_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/xdg-output-unstable-v1.xml"
    wayland-scanner private-code  "$XDGOUT_XML" "$WLC_GEN/xdg-output-v1-protocol.c"
    wayland-scanner server-header "$XDGOUT_XML" "$WLC_GEN/xdg-output-v1-server-protocol.h"
    wayland-scanner client-header "$XDGOUT_XML" "$WLC_GEN/xdg-output-v1-client-protocol.h"
    VIEWPORTER_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/viewporter.xml"
    wayland-scanner private-code  "$VIEWPORTER_XML" "$WLC_GEN/viewporter-protocol.c"
    wayland-scanner server-header "$VIEWPORTER_XML" "$WLC_GEN/viewporter-server-protocol.h"
    wayland-scanner client-header "$VIEWPORTER_XML" "$WLC_GEN/viewporter-client-protocol.h"
    FRACSCALE_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/fractional-scale-v1.xml"
    wayland-scanner private-code  "$FRACSCALE_XML" "$WLC_GEN/fractional-scale-v1-protocol.c"
    wayland-scanner server-header "$FRACSCALE_XML" "$WLC_GEN/fractional-scale-v1-server-protocol.h"
    wayland-scanner client-header "$FRACSCALE_XML" "$WLC_GEN/fractional-scale-v1-client-protocol.h"

    # Same for zwlr_data_control_manager_v1: the clipboard protocol a
    # windowless tool sets the selection through. wlclip-test drives it.
    DATACTL_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/wlr-data-control-unstable-v1.xml"
    wayland-scanner private-code  "$DATACTL_XML" "$WLC_GEN/wlr-data-control-v1-protocol.c"
    wayland-scanner server-header "$DATACTL_XML" "$WLC_GEN/wlr-data-control-v1-server-protocol.h"
    wayland-scanner client-header "$DATACTL_XML" "$WLC_GEN/wlr-data-control-v1-client-protocol.h"
    # Its standardized successor, ext_data_control_v1, which kclipd speaks.
    EXTDATACTL_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/ext-data-control-v1.xml"
    wayland-scanner private-code  "$EXTDATACTL_XML" "$WLC_GEN/ext-data-control-v1-protocol.c"
    wayland-scanner server-header "$EXTDATACTL_XML" "$WLC_GEN/ext-data-control-v1-server-protocol.h"
    wayland-scanner client-header "$EXTDATACTL_XML" "$WLC_GEN/ext-data-control-v1-client-protocol.h"
    # Same for ext_session_lock_v1, ext_idle_notifier_v1 and
    # hyprland_global_shortcuts_v1: the lock screen, the idle monitor and
    # the keybinds Quickshell's shell registers. The Hyprland XML comes from
    # the hyprland-protocols package.
    LOCK_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/ext-session-lock-v1.xml"
    wayland-scanner private-code  "$LOCK_XML" "$WLC_GEN/ext-session-lock-v1-protocol.c"
    wayland-scanner server-header "$LOCK_XML" "$WLC_GEN/ext-session-lock-v1-server-protocol.h"
    wayland-scanner client-header "$LOCK_XML" "$WLC_GEN/ext-session-lock-v1-client-protocol.h"
    IDLE_XML="$REPO_ROOT/packages/registry/wayland-protocols/xml/ext-idle-notify-v1.xml"
    wayland-scanner private-code  "$IDLE_XML" "$WLC_GEN/ext-idle-notify-v1-protocol.c"
    wayland-scanner server-header "$IDLE_XML" "$WLC_GEN/ext-idle-notify-v1-server-protocol.h"
    wayland-scanner client-header "$IDLE_XML" "$WLC_GEN/ext-idle-notify-v1-client-protocol.h"
    wlc_resolve hyprland-protocols
    WLC_HYPR_PROTOCOLS="$(wlc_path hyprland-protocols)"
    SHORTCUTS_XML="$WLC_HYPR_PROTOCOLS/share/hyprland-protocols/protocols/hyprland-global-shortcuts-v1.xml"
    wayland-scanner private-code  "$SHORTCUTS_XML" "$WLC_GEN/hyprland-global-shortcuts-v1-protocol.c"
    wayland-scanner server-header "$SHORTCUTS_XML" "$WLC_GEN/hyprland-global-shortcuts-v1-server-protocol.h"
    wayland-scanner client-header "$SHORTCUTS_XML" "$WLC_GEN/hyprland-global-shortcuts-v1-client-protocol.h"

    # libwayland-egl (step 12a): the wl_egl_window shim that SDL2's upstream
    # Wayland+GLES backend uses as its EGLNativeWindowType (see
    # libc/glue/libwayland-egl.c). Built + shipped by the libwayland
    # package — its build.toml `inputs` lists the glue sources, so glue
    # edits re-key the cache and rebuild it. The wayland-*.h copy loop
    # above already covers the wayland-egl headers.
    stage_sysroot_file "$WLC_LIBWL/lib/libwayland-egl.a" "$SYSROOT/lib/libwayland-egl.a"

    # Server. Link order: dependents (compositor + xdg glue) before
    # dependencies; libffi last so wl_closure_invoke's ffi_call resolves.
    # libwpkdraw renders the compositor's wallpaper (gradient + wordmark);
    # libEGL/libGLESv2 drive the GPU compositing path (CPU fallback when
    # the host has no WebGL2).
    # The wayland-demo package publishes the server itself; only the test
    # clients below still build here. The generated glue and the sysroot
    # copies above stay — libkwl and those clients need them.
    if package_owns_program_output wasm32 wlcompositor.wasm; then
        echo "  Skipping wlcompositor: a package publishes wlcompositor.wasm"
    else
        comp_wasm="$OUT_DIR_32/wlcompositor.wasm"
        echo "  Compiling wlcompositor (server)..."
        "$WASM32_CC" "${CFLAGS[@]}" "-I$WLC_GEN" "-I$WLC_LIBINPUT/include" \
            "$REPO_ROOT/programs/wlcompositor/wlcompositor.c" \
            "$WLC_GEN/xdg-shell-protocol.c" \
            "$WLC_GEN/linux-dmabuf-v1-protocol.c" \
            "$WLC_GEN/xdg-decoration-v1-protocol.c" \
            "$WLC_GEN/wlr-layer-shell-v1-protocol.c" \
            "$WLC_GEN/presentation-time-protocol.c" \
            "$WLC_GEN/xdg-output-v1-protocol.c" \
            "$WLC_GEN/viewporter-protocol.c" \
            "$WLC_GEN/fractional-scale-v1-protocol.c" \
            "$WLC_GEN/wlr-data-control-v1-protocol.c" \
            "$WLC_GEN/ext-data-control-v1-protocol.c" \
            "$WLC_GEN/ext-session-lock-v1-protocol.c" \
            "$WLC_GEN/ext-idle-notify-v1-protocol.c" \
            "$WLC_GEN/hyprland-global-shortcuts-v1-protocol.c" \
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
            -o "$comp_wasm"
        "$FORK_INSTRUMENT" "$comp_wasm" -o "$comp_wasm.instr"
        mv "$comp_wasm.instr" "$comp_wasm"
        record_built_program_output "$comp_wasm"
    fi

    # Client.
    client_wasm="$OUT_DIR_32/wlclient-test.wasm"
    echo "  Compiling wlclient-test (client)..."
    "$WASM32_CC" "${CFLAGS[@]}" "-I$WLC_GEN" \
        "$REPO_ROOT/programs/wlcompositor/wlclient-test.c" \
        "$WLC_GEN/xdg-shell-protocol.c" \
        "$WLC_GEN/xdg-decoration-v1-protocol.c" \
        "$WLC_GEN/presentation-time-protocol.c" \
        "$WLC_GEN/xdg-output-v1-protocol.c" \
        "$WLC_GEN/viewporter-protocol.c" \
        "$WLC_GEN/fractional-scale-v1-protocol.c" \
        "$WLC_GEN/ext-session-lock-v1-protocol.c" \
        "$WLC_GEN/ext-idle-notify-v1-protocol.c" \
        "$WLC_GEN/hyprland-global-shortcuts-v1-protocol.c" \
        "$SYSROOT/lib/libwayland-client.a" \
        "$SYSROOT/lib/libxkbcommon.a" \
        "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
        "$SYSROOT/lib/libffi.a" \
        -o "$client_wasm"
    "$FORK_INSTRUMENT" "$client_wasm" -o "$client_wasm.instr"
    mv "$client_wasm.instr" "$client_wasm"
    record_built_program_output "$client_wasm"

    # kwlctl (PR14c): the hyprctl-analog CLI over the compositor's
    # /tmp/kwlctl-0 control socket. Plain libc + sockets, no wayland libs.
    if [ -f "$REPO_ROOT/programs/wlcompositor/kwlctl.c" ]; then
        kwlctl_wasm="$OUT_DIR_32/kwlctl.wasm"
        echo "  Compiling kwlctl (control CLI)..."
        "$WASM32_CC" "${CFLAGS[@]}" \
            "$REPO_ROOT/programs/wlcompositor/kwlctl.c" \
            -o "$kwlctl_wasm"
        "$FORK_INSTRUMENT" "$kwlctl_wasm" -o "$kwlctl_wasm.instr"
        mv "$kwlctl_wasm.instr" "$kwlctl_wasm"
        record_built_program_output "$kwlctl_wasm"
    fi

    # Clipboard client: the wl_data_device selection and the
    # zwlr_data_control path, in the roles
    # host/test/wlcompositor-clipboard-smoke.test.ts gives it.
    if [ -f "$REPO_ROOT/programs/wlcompositor/wlclip-test.c" ]; then
        clip_wasm="$OUT_DIR_32/wlclip-test.wasm"
        echo "  Compiling wlclip-test (clipboard client)..."
        "$WASM32_CC" "${CFLAGS[@]}" "-I$WLC_GEN" \
            "$REPO_ROOT/programs/wlcompositor/wlclip-test.c" \
            "$WLC_GEN/xdg-shell-protocol.c" \
            "$WLC_GEN/wlr-data-control-v1-protocol.c" \
            "$SYSROOT/lib/libwayland-client.a" \
            "$SYSROOT/lib/libxkbcommon.a" \
            "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
            "$SYSROOT/lib/libffi.a" \
            -o "$clip_wasm"
        "$FORK_INSTRUMENT" "$clip_wasm" -o "$clip_wasm.instr"
        mv "$clip_wasm.instr" "$clip_wasm"
        record_built_program_output "$clip_wasm"
    fi

    # dmabuf client (PR11): drives the zwp_linux_dmabuf_v1 buffer path so
    # host/test/wlcompositor-dmabuf-smoke.test.ts can assert the compositor
    # composites a dmabuf-imported buffer. Links the dmabuf client glue.
    if [ -f "$REPO_ROOT/programs/wlcompositor/wldmabuf-test.c" ]; then
        dmabuf_wasm="$OUT_DIR_32/wldmabuf-test.wasm"
        echo "  Compiling wldmabuf-test (dmabuf client)..."
        "$WASM32_CC" "${CFLAGS[@]}" "-I$WLC_GEN" \
            "$REPO_ROOT/programs/wlcompositor/wldmabuf-test.c" \
            "$WLC_GEN/xdg-shell-protocol.c" \
            "$WLC_GEN/linux-dmabuf-v1-protocol.c" \
            "$SYSROOT/lib/libwayland-client.a" \
            "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
            "$SYSROOT/lib/libffi.a" \
            -o "$dmabuf_wasm"
        "$FORK_INSTRUMENT" "$dmabuf_wasm" -o "$dmabuf_wasm.instr"
        mv "$dmabuf_wasm.instr" "$dmabuf_wasm"
        record_built_program_output "$dmabuf_wasm"
    fi

fi

# libkwl (PR7 Phase 2): in-tree Wayland toolkit over libwayland-client.
# Built inline (NOT via the resolver — packages/registry/ only). Runs AFTER
# the wlcompositor block above so the wayland-client / xkbcommon / gbm /
# drm / ffi archives are already copied into the sysroot and the
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
    CC="$LLVM_BIN/clang" AR="$LLVM_BIN/llvm-ar" XDG_SHELL_INCLUDE="$KWL_GEN" \
        bash "$LIBKWL_DIR/build.sh" "$SYSROOT"

    # libkwl clients: kwldemo (PR7 Phase 2 gate), wlclock (animated analog
    # clock), wlpaint (palette + pointer-drag painting), kbar (the layer-shell
    # status bar) and klauncher (the layer-shell app launcher). Link order:
    # dependents before deps — app + xdg glue, then libkwl (calls
    # wpk_*/wl_*/xkb_*), then libwpkdraw, then the wayland stack, libffi
    # last so wl_closure_invoke's ffi_call resolves.
    for kwl_app in kwldemo wlclock wlpaint kbar klauncher knotify; do
        [ -f "$REPO_ROOT/programs/$kwl_app.c" ] || continue
        package_owns_program_output wasm32 "$kwl_app.wasm" && continue
        kwl_app_wasm="$OUT_DIR_32/$kwl_app.wasm"
        echo "  Compiling $kwl_app (libkwl client)..."
        "$WASM32_CC" "${CFLAGS[@]}" "-I$KWL_GEN" \
            "$REPO_ROOT/programs/$kwl_app.c" \
            "$KWL_GEN/xdg-shell-protocol.c" \
            "$KWL_GEN/xdg-decoration-v1-protocol.c" \
            "$KWL_GEN/wlr-layer-shell-v1-protocol.c" \
            "$SYSROOT/lib/libkwl.a" \
            "$SYSROOT/lib/libwpkdraw.a" \
            "$SYSROOT/lib/libwayland-client.a" \
            "$SYSROOT/lib/libxkbcommon.a" \
            "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
            "$SYSROOT/lib/libffi.a" \
            -o "$kwl_app_wasm"
        "$FORK_INSTRUMENT" "$kwl_app_wasm" -o "$kwl_app_wasm.instr"
        mv "$kwl_app_wasm.instr" "$kwl_app_wasm"
        record_built_program_output "$kwl_app_wasm"
    done
fi

# wlterm (PR7 Phase 3): a real terminal — a libkwl window + an in-tree VT100
# core (vt100.c) + a forkpty'd shell. Dedicated pass (like wlcompositor):
# multi-source link (wlterm.c + vt100.c + the generated xdg-shell glue) plus
# the libkwl/wpkdraw/wayland/xkb archives, and fork-instrumentation is
# MANDATORY because forkpty() forks (CLAUDE.md fork policy — must not
# silently degrade). Files live under programs/wlterm/ so the flat loop skips
# them. See docs/plans/2026-07-09-dri-pr7-libkwl-wlterm-plan.md §5.
if ls "$REPO_ROOT"/programs/wlterm/*.c >/dev/null 2>&1 &&
   ! package_owns_program_output wasm32 wlterm.wasm; then
    if [ ! -f "$SYSROOT/lib/libkwl.a" ]; then
        echo "Error: libkwl.a missing — the libkwl pass must run before wlterm." >&2
        exit 1
    fi
    echo "==> Building wlterm (libkwl terminal + VT100 + forkpty)..."
    wlterm_wasm="$OUT_DIR_32/wlterm.wasm"
    "$WASM32_CC" "${CFLAGS[@]}" "-I$KWL_GEN" \
        "$REPO_ROOT/programs/wlterm/wlterm.c" \
        "$REPO_ROOT/programs/wlterm/vt100.c" \
        "$KWL_GEN/xdg-shell-protocol.c" \
        "$KWL_GEN/xdg-decoration-v1-protocol.c" \
        "$KWL_GEN/wlr-layer-shell-v1-protocol.c" \
        "$SYSROOT/lib/libkwl.a" \
        "$SYSROOT/lib/libwpkdraw.a" \
        "$SYSROOT/lib/libwayland-client.a" \
        "$SYSROOT/lib/libxkbcommon.a" \
        "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
        "$SYSROOT/lib/libffi.a" \
        -o "$wlterm_wasm"
    # forkpty() forks — instrumentation is required, not optional.
    "$FORK_INSTRUMENT" "$wlterm_wasm" -o "$wlterm_wasm.instr"
    mv "$wlterm_wasm.instr" "$wlterm_wasm"
    record_built_program_output "$wlterm_wasm"
fi

for src in "$REPO_ROOT/programs/"*.cpp; do
    [ -f "$src" ] || continue
    build_cpp_program "$src" "$OUT_DIR_32"
done

# SDL2 playground app — every .c under programs/sdl2/ links into the
# single sdl2.wasm binary. Multi-source SDK invocation: the driver accepts
# the sources together with the full SDL2 + dependency archive set and adds
# its own glue, CRT and libc, then we run fork-instrument on the result.
# libEGL / libGLESv2 are named explicitly: the SDL_opengles2 header
# bundle transitively pulls <GLES2/gl2.h>, but the per-file grep in
# build_program only catches direct top-level EGL/GLES includes.
if ls "$REPO_ROOT"/programs/sdl2/*.c >/dev/null 2>&1; then
    # Regenerate the Inconsolata TTF→C byte-array header if missing or
    # older than the .ttf. The .h is git-ignored; the .ttf is the
    # source of truth (see third_party/NOTICE.md). The .ttf is vendored once
    # in the repository-root third_party/; only the generated header lives
    # under programs/sdl2/, so create its directory on a fresh checkout.
    sdl2_ttf="$REPO_ROOT/third_party/Inconsolata-Regular.ttf"
    sdl2_ttf_h="$REPO_ROOT/programs/sdl2/third_party/inconsolata_ttf.h"
    mkdir -p "$(dirname "$sdl2_ttf_h")"
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
    "/* See third_party/NOTICE.md for license. */\n"
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
    if package_owns_direct_program_path wasm32 sdl2.wasm; then
        # Same contract as build_program's ownership check: the sdl2-demo
        # recipe publishes this path through build-deps.
        if [ -e "$sdl2_wasm" ] && [ ! -L "$sdl2_wasm" ]; then
            echo "Error: package-owned resolver mirror is already occupied: $sdl2_wasm" >&2
            exit 1
        fi
        echo "  Skipping sdl2: package resolver owns wasm32/sdl2.wasm"
    else
        echo "  Compiling sdl2 (multi-source: ${#sdl2_sources[@]} file(s))..."
        "$WASM32_CC" "${CFLAGS[@]}" -I"$REPO_ROOT/third_party" "${sdl2_sources[@]}" \
            "$SYSROOT/lib/libSDL2.a" \
            "$SYSROOT/lib/libwayland-client.a" \
            "$SYSROOT/lib/libwayland-egl.a" \
            "$SYSROOT/lib/libwayland-cursor.a" \
            "$SYSROOT/lib/libxkbcommon.a" \
            "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
            "$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a" \
            "$SYSROOT/lib/libffi.a" \
            -o "$sdl2_wasm"
        "$FORK_INSTRUMENT" "$sdl2_wasm" -o "$sdl2_wasm.instr"
        mv "$sdl2_wasm.instr" "$sdl2_wasm"
        record_built_program_output "$sdl2_wasm"
    fi
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

    # Same contract as the wasm32 side above: the wasm64 SDK driver owns the
    # target, the sysroot64 path, the glue, crt1.o, libc.a and every -Wl flag.
    CFLAGS64=(
        -O2
    )

    for src in \
        "$REPO_ROOT/programs/"hello64.c \
        "$REPO_ROOT/programs/"ifhwaddr.c \
        "$REPO_ROOT/programs/"posix-timer-thread.c \
        "$REPO_ROOT/programs/"clipboard-device.c \
        "$REPO_ROOT/programs/"scm-rights-pipe-lifetime.c \
        "$REPO_ROOT/programs/"scm-rights-semantics.c \
        "$REPO_ROOT/programs/"sched-getaffinity.c; do
        [ -f "$src" ] || continue
        local_name=$(basename "$src" .c)
        echo "  Compiling $local_name (wasm64)..."
        extra_flags=()
        if [ "$local_name" = "posix-timer-thread" ]; then
            extra_flags=(--kandelo-thread-slots 8)
        fi
        # Keep empty optional flags safe under Bash 3.2 with `set -u`.
        "$WASM64_CC" "${CFLAGS64[@]}" ${extra_flags[@]+"${extra_flags[@]}"} "$src" \
            -o "$OUT_DIR_64/${local_name}.wasm"
        record_built_program_output "$OUT_DIR_64/${local_name}.wasm"
    done

    # WHY: owning Vitests can build these on demand, but browser-only and
    # packed CI workspaces cannot depend on a prior test runner leaving ambient
    # artifacts behind. Every browser-owned example comes from the one
    # contract-checked manifest. Their memory64 execution paths do not require
    # fork rewind instrumentation; the wait fixture selects posix_spawn because
    # that instrumentation is currently a wasm32 artifact contract.
    memory64_example_sources="$(browser_memory64_fixture_sources)"
    while IFS= read -r source_rel; do
        source_path="$REPO_ROOT/$source_rel"
        output_path="$REPO_ROOT/${source_rel%.c}.wasm64.wasm"
        echo "  Compiling $(basename "$source_rel" .c) (wasm64)..."
        "$WASM64_CC" "${CFLAGS64[@]}" "$source_path" \
            -o "$output_path"
        record_built_program_output "$output_path"
    done <<< "$memory64_example_sources"

    # Fork continuation instrumentation is currently a wasm32 artifact
    # contract. Still cover the compiler's architecture-independent SjLj /
    # noexcept ordering on wasm64 with a raw fixture that omits the dormant
    # fork anchor. Keep it in the test-only tree for symmetry with wasm32.
    sjlj_noexcept_src="$REPO_ROOT/programs/sjlj_noexcept_boundary.cpp"
    if [ -f "$sjlj_noexcept_src" ]; then
        LIBCXX_PREFIX_64="$(resolve_libcxx_prefix wasm64)"
        mkdir -p "$TEST_FIXTURE_DIR/wasm64"
        echo "  Compiling sjlj_noexcept_boundary (raw wasm64 test fixture)..."
        # shellcheck disable=SC2046
        "$WASM64_CXX" \
            -O2 \
            -fwasm-exceptions \
            -DKANDELO_SJLJ_NO_FORK_ANCHOR \
            $(libcxx_flags "$LIBCXX_PREFIX_64") \
            "$sjlj_noexcept_src" \
            -lc++ -lc++abi \
            -o "$TEST_FIXTURE_DIR/wasm64/sjlj_noexcept_boundary.raw.wasm"
        record_built_program_output "$TEST_FIXTURE_DIR/wasm64/sjlj_noexcept_boundary.raw.wasm"
    fi
fi

# WHY: the package build engine stamps every wasm member it installs with this
# checkout's kandelo.abi.contract digest, but these programs and fixtures are
# compiled here, outside that engine. Without the stamp the host reports a
# binary built seconds ago as a "legacy binary [that] predates the
# ABI-contract-digest rollout" (host/src/constants.ts) — a false claim that also
# writes to stderr, which breaks tests asserting the host stays quiet. Stamp
# them here so a locally built guest carries the same ABI identity a
# package-built one does. Only this run's recorded outputs are stamped; see
# scripts/build-programs-abi-stamp.sh for why the output trees are not swept.
echo "==> Stamping ABI contract digest on locally built programs..."
stamp_built_program_outputs

echo "Programs built."
