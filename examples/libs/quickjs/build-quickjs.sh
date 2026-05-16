#!/bin/bash
# Build QuickJS-NG (v0.12.1) for wasm32-posix-kernel
#
# Builds two binaries:
#   qjs.wasm  — QuickJS-NG interpreter with ES2023 + POSIX os/std modules
#   node.wasm — Node.js-compatible runtime with require(), process, Buffer,
#               and core modules (fs, path, events, os, util, stream, etc.)
#
# This is NOT Node.js. The `node` command provides Node.js API compatibility
# via a JavaScript layer on top of QuickJS-NG's POSIX capabilities.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/quickjs-src"
BIN_DIR="$SCRIPT_DIR/bin"
GEN_DIR="$BIN_DIR/gen"

if [ -z "${BUILD_NODE:-}" ]; then
    if [ "${WASM_POSIX_DEP_NAME:-}" = "quickjs" ]; then
        BUILD_NODE=0
    else
        BUILD_NODE=1
    fi
fi

# SDK tools — use the worktree-local SDK shims unconditionally. We do NOT
# honour an inherited $CC: in a Nix dev shell (flake.nix), `stdenv.cc`
# exports CC pointing at a Nix-wrapped host gcc, and that wrapper injects
# `-Wformat -Wformat-security -Werror=format-security` via
# NIX_CFLAGS_COMPILE. Combined with this script's `-Wno-format`, gcc's
# cc1 errors with "'-Wformat-security' ignored without '-Wformat'
# [-Werror=format-security]" — and even if that warning were appeased,
# the host gcc would emit native x86_64 objects rather than wasm32, so
# the link step against the wasm sysroot would fail anyway. Same logic
# for AR: a host `${AR:-ar}` produces archives the wasm linker can't
# read.
CC="wasm32posix-cc"
AR="wasm32posix-ar"

SYSROOT="$REPO_ROOT/sysroot"
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run 'bash build.sh' first."
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "Cloning quickjs-ng v0.12.1..."
    git clone --depth=1 --branch v0.12.1 https://github.com/quickjs-ng/quickjs.git "$SRC_DIR"
fi

# Apply local patches, skipping any already applied. Mirrors the pattern in
# examples/libs/mariadb/build-mariadb.sh.
PATCH_DIR="$SCRIPT_DIR/patches"
if [ -d "$PATCH_DIR" ]; then
    for patch in "$PATCH_DIR"/*.patch; do
        [ -f "$patch" ] || continue
        if patch -p1 -N --dry-run --silent -d "$SRC_DIR" < "$patch" 2>/dev/null; then
            echo "  Applying $(basename "$patch")..."
            patch -p1 -N -d "$SRC_DIR" < "$patch"
        fi
    done
fi

YYJSON_SRC_DIR="$SCRIPT_DIR/yyjson-src"
if [ "$BUILD_NODE" = "1" ] && [ ! -d "$YYJSON_SRC_DIR" ]; then
    echo "Cloning yyjson 0.10.0..."
    git clone --depth=1 --branch 0.10.0 https://github.com/ibireme/yyjson.git "$YYJSON_SRC_DIR"
fi

mkdir -p "$BIN_DIR" "$GEN_DIR"

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

# ----------------------------------------------------------------
# Step 1: Build host qjsc (native bytecode compiler)
# ----------------------------------------------------------------
HOST_BUILD_DIR="$SRC_DIR/build-host"
QJSC="$HOST_BUILD_DIR/qjsc"
if [ ! -f "$QJSC" ]; then
    echo "Building host qjsc..."
    mkdir -p "$HOST_BUILD_DIR"
    HOST_CC="${HOST_CC:-cc}"
    HOST_CFLAGS="-O2 -D_GNU_SOURCE -DQUICKJS_NG_BUILD -I$SRC_DIR -funsigned-char"

    # Build qjsc natively. Note: as of quickjs-ng v0.12, cutils.c was
    # removed and its functions inlined into cutils.h, so it's no
    # longer in the source list (older v0.11 builds compiled it).
    $HOST_CC $HOST_CFLAGS -c "$SRC_DIR/quickjs.c" -o "$HOST_BUILD_DIR/quickjs.o"
    $HOST_CC $HOST_CFLAGS -c "$SRC_DIR/dtoa.c" -o "$HOST_BUILD_DIR/dtoa.o"
    $HOST_CC $HOST_CFLAGS -c "$SRC_DIR/libregexp.c" -o "$HOST_BUILD_DIR/libregexp.o"
    $HOST_CC $HOST_CFLAGS -c "$SRC_DIR/libunicode.c" -o "$HOST_BUILD_DIR/libunicode.o"
    $HOST_CC $HOST_CFLAGS -c "$SRC_DIR/quickjs-libc.c" -o "$HOST_BUILD_DIR/quickjs-libc.o"
    $HOST_CC $HOST_CFLAGS -c "$SRC_DIR/qjsc.c" -o "$HOST_BUILD_DIR/qjsc.o"
    $HOST_CC $HOST_CFLAGS -c "$SRC_DIR/unicode_gen_def.c" -o "$HOST_BUILD_DIR/unicode_gen_def.o" 2>/dev/null || true
    $HOST_CC \
        "$HOST_BUILD_DIR/qjsc.o" \
        "$HOST_BUILD_DIR/quickjs.o" \
        "$HOST_BUILD_DIR/dtoa.o" \
        "$HOST_BUILD_DIR/libregexp.o" \
        "$HOST_BUILD_DIR/libunicode.o" \
        "$HOST_BUILD_DIR/quickjs-libc.o" \
        -lm -lpthread \
        -o "$QJSC"
    echo "Host qjsc built: $QJSC"
fi

# ----------------------------------------------------------------
# Step 2: Compile bootstrap.js to bytecode C array
# ----------------------------------------------------------------
if [ "$BUILD_NODE" = "1" ]; then
    echo "Compiling Node.js bootstrap to bytecode..."
    # -M qjs:node tells qjsc the module is external (linked in via node.wasm),
    # so bytecode emission doesn't try to resolve it at compile time.
    "$QJSC" -m \
        -N qjsc_bootstrap \
        -M qjs:node \
        -o "$GEN_DIR/node-bootstrap.c" \
        "$SCRIPT_DIR/node-compat/bootstrap.js"
    echo "Bootstrap bytecode generated: $GEN_DIR/node-bootstrap.c"
fi

# ----------------------------------------------------------------
# Step 3: Compile core library objects (shared between qjs and node)
# ----------------------------------------------------------------
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

# ----------------------------------------------------------------
# Step 4: Build qjs.wasm (plain QuickJS interpreter)
# ----------------------------------------------------------------
echo "Compiling qjs CLI..."
CLI_OBJS=()
for src in "${QJS_CLI_SRCS[@]}"; do
    obj="$BIN_DIR/$(basename "${src%.c}.o")"
    $CC "${CFLAGS[@]}" -c "$src" -o "$obj"
    CLI_OBJS+=("$obj")
done

# QuickJS records the wasm __stack_pointer at JS_NewContext as `stack_top`,
# then enforces a 1 MiB JS_DEFAULT_STACK_SIZE budget. Bump the wasm stack so
# the first JS call has headroom. lld only has a positive `--stack-first`
# switch on this toolchain; omitting it keeps the normal stack-last layout.
QJS_STACK_FLAGS=(-Wl,-z,stack-size=8388608)

echo "Linking qjs..."
$CC "${CLI_OBJS[@]}" "${OBJS[@]}" -lm "${QJS_STACK_FLAGS[@]}" -o "$BIN_DIR/qjs.wasm"

# Asyncify for fork support
echo "Applying asyncify to qjs..."
WASM_OPT="${WASM_OPT:-wasm-opt}"
$WASM_OPT --asyncify \
    --pass-arg="asyncify-imports@kernel.kernel_fork" \
    -O2 \
    "$BIN_DIR/qjs.wasm" -o "$BIN_DIR/qjs.wasm"

QJS_SIZE=$(wc -c < "$BIN_DIR/qjs.wasm" | tr -d ' ')

if [ "$BUILD_NODE" = "1" ]; then
    # ----------------------------------------------------------------
    # Step 5: Build node.wasm (Node.js compat layer)
    # ----------------------------------------------------------------
    echo "Compiling node CLI..."
    NODE_OBJS=()

    # Compile node-main.c
    $CC "${CFLAGS[@]}" -c "$SCRIPT_DIR/node-main.c" -o "$BIN_DIR/node-main.o"
    NODE_OBJS+=("$BIN_DIR/node-main.o")

    # Compile bootstrap bytecode
    $CC "${CFLAGS[@]}" -c "$GEN_DIR/node-bootstrap.c" -o "$BIN_DIR/node-bootstrap.o"
    NODE_OBJS+=("$BIN_DIR/node-bootstrap.o")

    # node.wasm also needs repl.c for interactive mode
    $CC "${CFLAGS[@]}" -c "$SRC_DIR/gen/repl.c" -o "$BIN_DIR/repl-node.o"
    NODE_OBJS+=("$BIN_DIR/repl-node.o")

    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    resolve_dep() {
        local name="$1"
        (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
    }

    OPENSSL_PREFIX="${WASM_POSIX_DEP_OPENSSL_DIR:-}"
    if [ -z "$OPENSSL_PREFIX" ]; then
        echo "Resolving openssl via cargo xtask build-deps..."
        OPENSSL_PREFIX="$(resolve_dep openssl)"
    fi
    if [ ! -f "$OPENSSL_PREFIX/lib/libcrypto.a" ] || [ ! -f "$OPENSSL_PREFIX/lib/libssl.a" ]; then
        echo "ERROR: openssl resolve returned '$OPENSSL_PREFIX' but libcrypto.a/libssl.a are missing." >&2
        exit 1
    fi

    ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
    if [ -z "$ZLIB_PREFIX" ]; then
        echo "Resolving zlib via cargo xtask build-deps..."
        ZLIB_PREFIX="$(resolve_dep zlib)"
    fi
    if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ]; then
        echo "ERROR: zlib resolve returned '$ZLIB_PREFIX' but libz.a is missing." >&2
        exit 1
    fi

    NODE_NATIVE_SRCS=(
        "$SCRIPT_DIR/node-compat-native/node-native.c"
        "$SCRIPT_DIR/node-compat-native/hash.c"
        "$SCRIPT_DIR/node-compat-native/hmac.c"
        "$SCRIPT_DIR/node-compat-native/zlib.c"
        "$SCRIPT_DIR/node-compat-native/socket.c"
        "$SCRIPT_DIR/node-compat-native/tls.c"
        "$SCRIPT_DIR/node-compat-native/json.c"
        "$YYJSON_SRC_DIR/src/yyjson.c"
    )
    NODE_NATIVE_CFLAGS=(
        "${CFLAGS[@]}"
        -I"$OPENSSL_PREFIX/include"
        -I"$ZLIB_PREFIX/include"
        -I"$YYJSON_SRC_DIR/src"
    )
    for src in "${NODE_NATIVE_SRCS[@]}"; do
        obj="$BIN_DIR/$(basename "${src%.c}.o")"
        $CC "${NODE_NATIVE_CFLAGS[@]}" -c "$src" -o "$obj"
        NODE_OBJS+=("$obj")
    done

    echo "Linking node..."
    $CC "${NODE_OBJS[@]}" "${OBJS[@]}" \
        "$OPENSSL_PREFIX/lib/libssl.a" \
        "$OPENSSL_PREFIX/lib/libcrypto.a" \
        "$ZLIB_PREFIX/lib/libz.a" \
        -lm \
        "${QJS_STACK_FLAGS[@]}" -o "$BIN_DIR/node.wasm"

    # Asyncify for fork support
    echo "Applying asyncify to node..."
    $WASM_OPT --asyncify \
        --pass-arg="asyncify-imports@kernel.kernel_fork" \
        -O2 \
        "$BIN_DIR/node.wasm" -o "$BIN_DIR/node.wasm"

    NODE_SIZE=$(wc -c < "$BIN_DIR/node.wasm" | tr -d ' ')
fi

# ----------------------------------------------------------------
# Summary
# ----------------------------------------------------------------
echo ""
echo "=== QuickJS-NG built successfully ==="
echo "  qjs.wasm:  $QJS_SIZE bytes  (QuickJS interpreter)"
if [ "$BUILD_NODE" = "1" ]; then
    echo "  node.wasm: $NODE_SIZE bytes (Node.js compat layer)"
fi
echo ""
echo "qjs  — ES2023 JavaScript interpreter with POSIX os/std modules"
if [ "$BUILD_NODE" = "1" ]; then
    echo "node — Node.js-compatible runtime (require, process, Buffer, fs, etc.)"
fi
echo ""
if [ "$BUILD_NODE" = "1" ]; then
    echo "This is NOT Node.js. The 'node' command provides API compatibility"
    echo "via QuickJS-NG. Core modules: assert, buffer, child_process, crypto,"
    echo "events, fs, http, net, os, path, querystring, stream, url, util, etc."
fi

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary quickjs "$BIN_DIR/qjs.wasm" qjs.wasm
if [ "$BUILD_NODE" = "1" ] && [ -f "$BIN_DIR/node.wasm" ]; then
    install_local_binary node "$BIN_DIR/node.wasm" node.wasm
fi
