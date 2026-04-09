#!/bin/bash
# Build QuickJS-NG (v0.12.1) for wasm32-posix-kernel
#
# QuickJS-NG is a maintained fork of Fabrice Bellard's QuickJS engine.
# This builds `qjs` as a shell utility — a standalone JavaScript interpreter
# with ES2023 support and POSIX os/std modules.
#
# This is NOT Node.js. It is a QuickJS-based JS runtime registered as a
# node-compatible shell utility. It provides `qjs` and `node` commands.
# The `node` command is a convenience alias; it does not implement the
# full Node.js API (no require('fs'), require('http'), etc.).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/quickjs-src"
BIN_DIR="$SCRIPT_DIR/bin"

# SDK tools
CC="${CC:-wasm32posix-cc}"
AR="${AR:-wasm32posix-ar}"

SYSROOT="$REPO_ROOT/sysroot"
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run 'bash build.sh' first."
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "Cloning quickjs-ng v0.12.1..."
    git clone --depth=1 --branch v0.12.1 https://github.com/quickjs-ng/quickjs.git "$SRC_DIR"
fi

mkdir -p "$BIN_DIR"

echo "=== Building QuickJS-NG for wasm32 ==="

# QuickJS source files
QJS_CORE_SRCS=(
    "$SRC_DIR/quickjs.c"
    "$SRC_DIR/dtoa.c"
    "$SRC_DIR/libregexp.c"
    "$SRC_DIR/libunicode.c"
)

QJS_LIBC_SRCS=(
    "$SRC_DIR/quickjs-libc.c"
)

QJS_CLI_SRCS=(
    "$SRC_DIR/qjs.c"
    "$SRC_DIR/gen/repl.c"
    "$SRC_DIR/gen/standalone.c"
)

CFLAGS=(
    -O2
    -D_GNU_SOURCE
    -DQUICKJS_NG_BUILD
    # We are NOT __wasi__ — our kernel has full POSIX support (fork, exec,
    # pipes, signals, termios, dlopen, etc.). Don't define __wasi__.
    # QuickJS detects threads via platform checks in cutils.h. Since we're
    # not __wasi__/EMSCRIPTEN, it enables JS_HAVE_THREADS=1 and includes
    # pthread.h (available in our musl sysroot). Worker threads won't
    # actually work without full kernel thread support, but the core
    # interpreter compiles and runs fine with thread support compiled in.
    # funsigned-char is required by quickjs
    -funsigned-char
    -I"$SRC_DIR"
    # Suppress warnings that don't affect correctness
    -Wno-sign-compare
    -Wno-unused-parameter
    -Wno-implicit-fallthrough
    -Wno-format  # %lld format issues on wasm32
)

# Step 1: Compile core library objects
echo "Compiling quickjs core..."
OBJS=()
for src in "${QJS_CORE_SRCS[@]}"; do
    obj="$BIN_DIR/$(basename "${src%.c}.o")"
    $CC "${CFLAGS[@]}" -c "$src" -o "$obj"
    OBJS+=("$obj")
done

echo "Compiling quickjs-libc..."
for src in "${QJS_LIBC_SRCS[@]}"; do
    obj="$BIN_DIR/$(basename "${src%.c}.o")"
    $CC "${CFLAGS[@]}" -c "$src" -o "$obj"
    OBJS+=("$obj")
done

echo "Compiling qjs CLI..."
CLI_OBJS=()
for src in "${QJS_CLI_SRCS[@]}"; do
    obj="$BIN_DIR/$(basename "${src%.c}.o")"
    $CC "${CFLAGS[@]}" -c "$src" -o "$obj"
    CLI_OBJS+=("$obj")
done

# Step 2: Link
echo "Linking qjs..."
$CC "${CLI_OBJS[@]}" "${OBJS[@]}" -lm -o "$BIN_DIR/qjs.wasm"

# Step 3: Asyncify for fork support
echo "Applying asyncify..."
WASM_OPT="${WASM_OPT:-wasm-opt}"
$WASM_OPT --asyncify \
    --pass-arg="asyncify-imports@kernel.kernel_fork" \
    -O2 \
    "$BIN_DIR/qjs.wasm" -o "$BIN_DIR/qjs.wasm"

SIZE=$(wc -c < "$BIN_DIR/qjs.wasm" | tr -d ' ')
echo ""
echo "=== QuickJS-NG built successfully ==="
echo "Binary: $BIN_DIR/qjs.wasm ($SIZE bytes)"
echo ""
echo "This is QuickJS-NG, a JavaScript interpreter with ES2023 support."
echo "It is NOT Node.js. It provides 'qjs' and 'node' as shell commands."
echo "The 'node' alias is for convenience only — no Node.js API is available."
