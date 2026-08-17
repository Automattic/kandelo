#!/bin/bash
set -euo pipefail

# Build musl libc as a static library targeting wasm32 or wasm64.
#
# Usage:
#   scripts/build-musl.sh              # build wasm32posix (default)
#   scripts/build-musl.sh --arch wasm64posix   # build wasm64posix
#
# Approach:
#   1. Copy overlay files from libc/musl-overlay/ into libc/musl/arch/<ARCH>/
#   2. Write config.mak directly (bypassing configure which doesn't know our arch)
#   3. Run make to build libc.a and CRT objects
#   4. Install headers + libs into sysroot/

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUSL_DIR="$REPO_ROOT/libc/musl"
OVERLAY_DIR="$REPO_ROOT/libc/musl-overlay"

# Parse arguments
ARCH="wasm32posix"
while [ $# -gt 0 ]; do
    case "$1" in
        --arch) ARCH="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

case "$ARCH" in
    wasm32posix)
        TARGET="wasm32-unknown-unknown"
        SYSROOT="$REPO_ROOT/sysroot"
        SETJMP_DIR="wasm32"
        SIGSETJMP_DIR="wasm32posix"
        ;;
    wasm64posix)
        TARGET="wasm64-unknown-unknown"
        SYSROOT="$REPO_ROOT/sysroot64"
        SETJMP_DIR="wasm32"  # TODO: may need wasm64 variant
        SIGSETJMP_DIR="wasm32posix"  # Same signal implementation
        ;;
    *)
        echo "Error: unsupported arch '$ARCH'. Use wasm32posix or wasm64posix." >&2
        exit 1
        ;;
esac

if [ -z "${LLVM_BIN:-}" ]; then
    if [ -n "${LLVM_PREFIX:-}" ]; then
        LLVM_BIN="$LLVM_PREFIX/bin"
    else
        echo "Error: LLVM_BIN is not set. Run scripts/dev-shell.sh or set LLVM_BIN/LLVM_PREFIX." >&2
        exit 1
    fi
fi
export LLVM_BIN
CC="$LLVM_BIN/clang"
AR="$LLVM_BIN/llvm-ar"
RANLIB="$LLVM_BIN/llvm-ranlib"

# Verify toolchain exists
for tool in "$CC" "$AR" "$RANLIB"; do
    if [ ! -x "$tool" ]; then
        echo "Error: $tool not found. Run scripts/dev-shell.sh or set LLVM_BIN/LLVM_PREFIX." >&2
        exit 1
    fi
done

# ---------------------------------------------------------------
# 1. Copy overlay files into musl source tree
# ---------------------------------------------------------------
echo "==> Copying overlay files for $ARCH..."
rm -rf "$MUSL_DIR/arch/$ARCH"
cp -r "$OVERLAY_DIR/arch/$ARCH" "$MUSL_DIR/arch/"

# Copy source file overlays (e.g., Wasm-specific __libc_start_main.c)
# First, clean arch-specific dirs in musl tree to remove stale overlay files
if [ -d "$OVERLAY_DIR/src" ]; then
    find "$OVERLAY_DIR/src" -type d -name wasm32posix | while read dir; do
        rel="${dir#$OVERLAY_DIR/src/}"
        rm -rf "$MUSL_DIR/src/$rel"
    done
    cp -r "$OVERLAY_DIR/src/"* "$MUSL_DIR/src/"

    # For wasm64posix: copy wasm32posix source overrides as wasm64posix
    # (same source code, just different arch dir name for musl's build system)
    if [ "$ARCH" = "wasm64posix" ]; then
        find "$OVERLAY_DIR/src" -type d -name wasm32posix | while read dir; do
            rel="${dir#$OVERLAY_DIR/src/}"
            parent="$(dirname "$rel")"
            rm -rf "$MUSL_DIR/src/$parent/wasm64posix"
            cp -r "$dir" "$MUSL_DIR/src/$parent/wasm64posix"
        done
    fi
fi

# musl's src/internal/syscall.h uses syscall_arg_t for the public
# varargs syscall() path and also hard-codes it into the non-varargs
# __syscall_cp() cancellation-point prototype. On wasm32posix those
# two paths intentionally differ:
#
#   - syscall_arg_t must remain long/i32 because syscall(long, ...)
#     reads varargs with va_arg(ap, syscall_arg_t); widening that type
#     would read past 32-bit caller arguments.
#   - __syscall_cp() is not variadic and must use the same widened i64
#     slots as __syscallN so cancellation-point syscalls preserve
#     64-bit offsets/lengths and match libc/glue/channel_syscall.c's
#     wasm function signature.
#
# Let arch/syscall_arch.h opt into separate syscall-number and argument
# types while keeping upstream musl behavior for arches that define neither.
python3 - "$MUSL_DIR/src/internal/syscall.h" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

default_block = """#ifndef SYSCALL_CP_NR_T
#define SYSCALL_CP_NR_T syscall_arg_t
#endif
#ifndef SYSCALL_CP_ARG_T
#define SYSCALL_CP_ARG_T syscall_arg_t
#endif

"""
old_default_block = """#ifndef SYSCALL_CP_ARG_T
#define SYSCALL_CP_ARG_T syscall_arg_t
#endif

"""
insert_after = """#endif

"""
if "SYSCALL_CP_NR_T" not in text:
    if old_default_block in text:
        text = text.replace(old_default_block, default_block, 1)
    elif "SYSCALL_CP_ARG_T" in text:
        raise SystemExit("build-musl: found an unknown partial syscall-cp type patch")
    else:
        marker = insert_after + "hidden long __syscall_ret"
        if marker not in text:
            raise SystemExit("build-musl: could not patch syscall.h: insertion marker not found")
        text = text.replace(marker, insert_after + default_block + "hidden long __syscall_ret", 1)

old_proto = """__syscall_cp(syscall_arg_t, syscall_arg_t, syscall_arg_t, syscall_arg_t,
\t             syscall_arg_t, syscall_arg_t, syscall_arg_t)"""
intermediate_proto = """__syscall_cp(SYSCALL_CP_ARG_T, SYSCALL_CP_ARG_T, SYSCALL_CP_ARG_T, SYSCALL_CP_ARG_T,
\t             SYSCALL_CP_ARG_T, SYSCALL_CP_ARG_T, SYSCALL_CP_ARG_T)"""
new_proto = """__syscall_cp(SYSCALL_CP_NR_T, SYSCALL_CP_ARG_T, SYSCALL_CP_ARG_T, SYSCALL_CP_ARG_T,
\t             SYSCALL_CP_ARG_T, SYSCALL_CP_ARG_T, SYSCALL_CP_ARG_T)"""
for candidate in (old_proto, intermediate_proto):
    if candidate in text:
        text = text.replace(candidate, new_proto, 1)
        break
else:
    if new_proto not in text:
        raise SystemExit("build-musl: could not patch syscall.h: __syscall_cp prototype not found")

path.write_text(text)
PY

python3 - "$MUSL_DIR/src/thread/__syscall_cp.c" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

replacements = [
    (
        """static long sccp(syscall_arg_t nr,
                 syscall_arg_t u, syscall_arg_t v, syscall_arg_t w,
                 syscall_arg_t x, syscall_arg_t y, syscall_arg_t z)""",
        """static long sccp(SYSCALL_CP_ARG_T nr,
                 SYSCALL_CP_ARG_T u, SYSCALL_CP_ARG_T v, SYSCALL_CP_ARG_T w,
                 SYSCALL_CP_ARG_T x, SYSCALL_CP_ARG_T y, SYSCALL_CP_ARG_T z)""",
        """static long sccp(SYSCALL_CP_NR_T nr,
                 SYSCALL_CP_ARG_T u, SYSCALL_CP_ARG_T v, SYSCALL_CP_ARG_T w,
                 SYSCALL_CP_ARG_T x, SYSCALL_CP_ARG_T y, SYSCALL_CP_ARG_T z)""",
    ),
    (
        """long (__syscall_cp)(syscall_arg_t nr,
                    syscall_arg_t u, syscall_arg_t v, syscall_arg_t w,
                    syscall_arg_t x, syscall_arg_t y, syscall_arg_t z)""",
        """long (__syscall_cp)(SYSCALL_CP_ARG_T nr,
                    SYSCALL_CP_ARG_T u, SYSCALL_CP_ARG_T v, SYSCALL_CP_ARG_T w,
                    SYSCALL_CP_ARG_T x, SYSCALL_CP_ARG_T y, SYSCALL_CP_ARG_T z)""",
        """long (__syscall_cp)(SYSCALL_CP_NR_T nr,
                    SYSCALL_CP_ARG_T u, SYSCALL_CP_ARG_T v, SYSCALL_CP_ARG_T w,
                    SYSCALL_CP_ARG_T x, SYSCALL_CP_ARG_T y, SYSCALL_CP_ARG_T z)""",
    ),
]
for upstream, intermediate, final in replacements:
    for candidate in (upstream, intermediate):
        if candidate in text:
            text = text.replace(candidate, final, 1)
            break
    else:
        if final not in text:
            raise SystemExit(f"build-musl: could not patch __syscall_cp.c pattern: {upstream.splitlines()[0]}")

path.write_text(text)
PY

# Copy CRT overlay (e.g., Wasm-specific crt1.c with proper main signature)
if [ -d "$OVERLAY_DIR/crt" ]; then
    cp -r "$OVERLAY_DIR/crt/"* "$MUSL_DIR/crt/"
fi

# ---------------------------------------------------------------
# 2. Write config.mak
# ---------------------------------------------------------------
echo "==> Writing config.mak..."
cat > "$MUSL_DIR/config.mak" << EOF
ARCH = $ARCH
srcdir = .
prefix = $SYSROOT
CC = $CC --target=$TARGET
AR = $AR
RANLIB = $RANLIB
CFLAGS = -O2 -matomics -mbulk-memory -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false -fno-trapping-math
CFLAGS_AUTO =
LDFLAGS_AUTO =
LIBCC =
# We only want the static library, not shared or tools
SHARED_LIBS =
ALL_LIBS = \$(CRT_LIBS) \$(STATIC_LIBS) \$(EMPTY_LIBS)
ALL_TOOLS =
EOF

# ---------------------------------------------------------------
# 3. Clean previous build
# ---------------------------------------------------------------
echo "==> Cleaning previous build..."
cd "$MUSL_DIR"
make clean 2>/dev/null || true

# ---------------------------------------------------------------
# 4. Build musl
# ---------------------------------------------------------------
NJOBS=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)

echo "==> Building musl (pass 1: discover failures)..."

# First, try a full build and capture failures
set +e
make -j"$NJOBS" 2>&1 | tee /tmp/musl-build.log
BUILD_RC=${PIPESTATUS[0]}
set -e

if [ $BUILD_RC -ne 0 ]; then
    echo ""
    echo "==> Build had errors. Analyzing failures..."
    # Extract failing source files from the log
    grep -oE 'obj/[^ ]+\.o' /tmp/musl-build.log | sort -u | head -40
    echo ""
    echo "==> See /tmp/musl-build.log for full output"
    exit 1
fi

# ---------------------------------------------------------------
# 5. Install to sysroot
# ---------------------------------------------------------------
echo "==> Installing to sysroot..."
rm -rf "$SYSROOT"
make install

# ---------------------------------------------------------------
# 6. Build __main_void wrapper and add to libc.a
# ---------------------------------------------------------------
echo "==> Building __main_void wrapper..."
"$CC" --target=$TARGET -O2 -c \
    "$OVERLAY_DIR/src/env/__main_void.c" \
    -o "$SYSROOT/lib/__main_void.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/__main_void.o"

# ---------------------------------------------------------------
# 7. Build setjmp runtime (requires -fwasm-exceptions for __builtin_wasm_throw)
# ---------------------------------------------------------------
echo "==> Building setjmp runtime..."
"$CC" --target=$TARGET -O2 \
    -fwasm-exceptions -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -c "$OVERLAY_DIR/src/setjmp/$SETJMP_DIR/rt.c" \
    -o "$SYSROOT/lib/wasm_setjmp_rt.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/wasm_setjmp_rt.o"

# ---------------------------------------------------------------
# 8. Build sigsetjmp helpers and add to libc.a
# ---------------------------------------------------------------
echo "==> Building sigsetjmp helpers..."
"$CC" --target=$TARGET -O2 \
    -matomics -mbulk-memory \
    -I"$SYSROOT/include" \
    -c "$OVERLAY_DIR/src/signal/$SIGSETJMP_DIR/sigsetjmp.c" \
    -o "$SYSROOT/lib/sigsetjmp_helpers.o"
"$AR" rcs "$SYSROOT/lib/libc.a" "$SYSROOT/lib/sigsetjmp_helpers.o"

# ---------------------------------------------------------------
# 9. Install override headers
# ---------------------------------------------------------------
echo "==> Installing override headers..."
bash "$REPO_ROOT/scripts/install-overlay-headers.sh" "$SYSROOT"

# ---------------------------------------------------------------
# 10. Build platform graphics/DRI stub libraries
# ---------------------------------------------------------------
if [ "$ARCH" = "wasm32posix" ]; then
    echo "==> Building platform graphics stubs..."
    bash "$REPO_ROOT/scripts/build-dri-stubs.sh"
    bash "$REPO_ROOT/scripts/build-gles-stubs.sh"
fi

echo ""
echo "==> musl build complete!"
echo "    Sysroot: $SYSROOT"
echo "    libc.a:  $SYSROOT/lib/libc.a"
ls -la "$SYSROOT/lib/libc.a" 2>/dev/null || echo "    WARNING: libc.a not found!"
