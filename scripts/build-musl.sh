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
NM="$LLVM_BIN/llvm-nm"
READOBJ="$LLVM_BIN/llvm-readobj"
LD="$LLVM_BIN/wasm-ld"
LD_ARCH_ARGS=()
if [ "$ARCH" = "wasm64posix" ]; then
    # WHY: unlike clang, wasm-ld does not infer the memory model from a
    # relocatable input. Without this explicit emulation it rejects the
    # wasm64 process-libc objects after musl has otherwise built successfully.
    LD_ARCH_ARGS=(-mwasm64)
fi

# Verify toolchain exists
for tool in "$CC" "$AR" "$RANLIB" "$NM" "$READOBJ" "$LD"; do
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
# 9. Build the resolved process-libc fallback and retention anchor used by dlopen
# ---------------------------------------------------------------
echo "==> Building dynamic process-libc object and retention anchor..."
DYNAMIC_LIBC="$SYSROOT/lib/libc-dynamic.o"
DYNAMIC_LIBC_ARCHIVE="$MUSL_DIR/obj/libc-dynamic-strong.a"
DYNAMIC_LIBC_RESOLVED_STRONG="$MUSL_DIR/obj/libc-dynamic-resolved-strong.o"
DYNAMIC_LIBC_SYMBOLS="$MUSL_DIR/obj/dynamic-libc-symbols.txt"
DYNAMIC_LIBC_ANCHOR_SOURCE="$MUSL_DIR/obj/dynamic-libc-anchor.c"
DYNAMIC_LIBC_ANCHOR="$SYSROOT/lib/libc-dynamic-anchor.o"

# A dlopen-capable Wasm executable must expose libc routines that only a
# future side module references. Resolve those routines from the strong musl
# archive first so mutually exclusive implementations (notably allocators)
# remain coherent, then weaken the resolved object so executable definitions
# interpose exactly as they do over a native shared libc.
cp "$SYSROOT/lib/libc.a" "$DYNAMIC_LIBC_ARCHIVE"
DYNAMIC_LIBC_EXCLUDED_MEMBERS=(
    dladdr.o
    dlclose.o
    dlerror.o
    dlopen.o
    dlsym.o
    _Fork.o
    fork.o
    vfork.o
    __syscall_cp.o
    sigsetjmp_helpers.o
)
for member in "${DYNAMIC_LIBC_EXCLUDED_MEMBERS[@]}"; do
    if ! "$AR" t "$DYNAMIC_LIBC_ARCHIVE" | grep -Fx "$member" >/dev/null; then
        echo "ERROR: expected $member in $DYNAMIC_LIBC_ARCHIVE" >&2
        exit 1
    fi
done
"$AR" d "$DYNAMIC_LIBC_ARCHIVE" "${DYNAMIC_LIBC_EXCLUDED_MEMBERS[@]}"
"$RANLIB" "$DYNAMIC_LIBC_ARCHIVE"

"$READOBJ" --symbols "$DYNAMIC_LIBC_ARCHIVE" 2>/dev/null |
    awk '
function emit() {
    if (name ~ /^[A-Za-z_][A-Za-z0-9_]*$/ && !undefined && !local &&
        (type == "FUNCTION" || type == "DATA")) print type, name
}
/^  Symbol \{$/ {
    in_symbol=1; name=""; type=""; undefined=0; local=0; next
}
in_symbol && /^    Name: / { name=$2; next }
in_symbol && /^    Type: / { type=$2; next }
in_symbol && /UNDEFINED/ { undefined=1; next }
in_symbol && /BINDING_LOCAL/ { local=1; next }
in_symbol && /^  \}$/ { emit(); in_symbol=0 }
' | LC_ALL=C sort -u > "$DYNAMIC_LIBC_SYMBOLS"

awk '
BEGIN {
    print "typedef void (*kandelo_dynamic_function)(void);"
}
$1 == "FUNCTION" {
    functions[++function_count]=$2
    print "extern void " $2 "(void);"
}
$1 == "DATA" {
    data[++data_count]=$2
    print "extern unsigned char " $2 ";"
}
END {
    print "__attribute__((used, visibility(\"hidden\")))"
    print "kandelo_dynamic_function const __kandelo_dynamic_libc_functions[] = {"
    for (i=1; i<=function_count; i++) print "    " functions[i] ","
    print "};"
    print "__attribute__((used, visibility(\"hidden\")))"
    print "void const *const __kandelo_dynamic_libc_data[] = {"
    for (i=1; i<=data_count; i++) print "    &" data[i] ","
    print "};"
}
' "$DYNAMIC_LIBC_SYMBOLS" > "$DYNAMIC_LIBC_ANCHOR_SOURCE"
"$CC" --target="$TARGET" -O2 -fPIC -fno-builtin -w \
    -matomics -mbulk-memory -mexception-handling \
    -c "$DYNAMIC_LIBC_ANCHOR_SOURCE" -o "$DYNAMIC_LIBC_ANCHOR"

if ! "$NM" --undefined-only --format=posix "$DYNAMIC_LIBC_ANCHOR" \
    2>/dev/null | grep -E '^ntohs U ' >/dev/null; then
    echo "ERROR: $DYNAMIC_LIBC_ANCHOR does not retain ntohs" >&2
    exit 1
fi

# The anchor's strong undefined relocations make the ordinary archive
# resolver choose one definition for every process-libc symbol. A native
# shared libc then acts as a fallback to strong executable definitions.
"$LD" "${LD_ARCH_ARGS[@]}" -r --allow-undefined "$DYNAMIC_LIBC_ANCHOR" \
    "$DYNAMIC_LIBC_ARCHIVE" -o "$DYNAMIC_LIBC_RESOLVED_STRONG"

# wasm-ld supports weak Wasm definitions, but llvm-objcopy does not implement
# Wasm symbol weakening. The repository transformer changes only the binding
# bits in the already-resolved object; code, data, and relocations stay exact.
HOST_TARGET="$(rustc -vV | awk '/^host:/ { print $2 }')"
if [ -z "$HOST_TARGET" ]; then
    echo "ERROR: rustc -vV did not report a host target" >&2
    exit 1
fi
(
    cd "$REPO_ROOT"
    cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
        weaken-wasm-object "$DYNAMIC_LIBC_RESOLVED_STRONG" "$DYNAMIC_LIBC"
)
if ! "$NM" --defined-only --format=posix "$DYNAMIC_LIBC" 2>/dev/null |
    grep -E '^malloc W ' >/dev/null; then
    echo "ERROR: $DYNAMIC_LIBC does not provide weak malloc" >&2
    exit 1
fi

# ---------------------------------------------------------------
# 10. Install override headers
# ---------------------------------------------------------------
echo "==> Installing override headers..."
bash "$REPO_ROOT/scripts/install-overlay-headers.sh" "$SYSROOT"

# ---------------------------------------------------------------
# 11. Build platform graphics/DRI stub libraries
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
echo "    dynamic: $DYNAMIC_LIBC"
echo "    anchor:  $DYNAMIC_LIBC_ANCHOR"
ls -la "$SYSROOT/lib/libc.a" 2>/dev/null || echo "    WARNING: libc.a not found!"
ls -la "$DYNAMIC_LIBC" 2>/dev/null || echo "    WARNING: libc-dynamic.o not found!"
ls -la "$DYNAMIC_LIBC_ANCHOR" 2>/dev/null || echo "    WARNING: libc-dynamic-anchor.o not found!"
