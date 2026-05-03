#!/usr/bin/env bash
#
# Build SQLite static library (libsqlite3.a) — and, in legacy mode,
# the sqlite3 CLI binary too — for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/dependency-management.md). When resolver env vars are set,
# only the library is produced, installed into the shared cache. When
# invoked directly (`bash build-sqlite.sh`), also builds the CLI and
# registers it with local-binaries/ so the resolver picks it over the
# fetched release.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/sqlite-src"

# --- Resolver contract (with legacy fallbacks) ---
SQLITE_VERSION="${WASM_POSIX_DEP_VERSION:-${SQLITE_VERSION:-3.49.1}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/sqlite-install}"
# Legacy default URL uses the packed version form (3.49.1 → 3490100).
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

# CLI is a consumer artifact, not a library. Skip it when invoked via
# the resolver — it would waste cache space and the consumer-side
# tooling will build it independently.
BUILD_CLI=1
[ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ] && BUILD_CLI=0

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR/sqlite3.c" ] && [ ! -f "$SRC_DIR/sqlite3.c" ]; then
    echo "==> Downloading SQLite $SQLITE_VERSION..."
    TARBALL="/tmp/sqlite-amalgamation.zip"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    unzip -o "$TARBALL" -d "$SRC_DIR"
    # Flatten the single-directory zip.
    inner=$(find "$SRC_DIR" -mindepth 1 -maxdepth 1 -type d -name 'sqlite-amalgamation-*' | head -1)
    if [ -n "$inner" ]; then
        mv "$inner"/* "$SRC_DIR/"
        rmdir "$inner"
    fi
    rm "$TARBALL"
fi

SQLITE_CFLAGS="-O2 \
    -DSQLITE_OMIT_LOAD_EXTENSION \
    -DSQLITE_THREADSAFE=0 \
    -DSQLITE_OMIT_WAL \
    -DSQLITE_DEFAULT_SYNCHRONOUS=0 \
    -DSQLITE_ENABLE_FTS5 \
    -DSQLITE_ENABLE_JSON1 \
    -DSQLITE_ENABLE_MATH_FUNCTIONS"

# --- Compile library ---
echo "==> Compiling SQLite for Wasm..."
# shellcheck disable=SC2086
wasm32posix-cc -c $SQLITE_CFLAGS \
    "$SRC_DIR/sqlite3.c" -o "$SRC_DIR/sqlite3.o"

wasm32posix-ar rcs "$SRC_DIR/libsqlite3.a" "$SRC_DIR/sqlite3.o"

# --- Install library into INSTALL_DIR ---
echo "==> Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include" "$INSTALL_DIR/lib/pkgconfig"

cp "$SRC_DIR/sqlite3.h" "$SRC_DIR/sqlite3ext.h" "$INSTALL_DIR/include/"
cp "$SRC_DIR/libsqlite3.a" "$INSTALL_DIR/lib/"

cat > "$INSTALL_DIR/lib/pkgconfig/sqlite3.pc" <<PCEOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: SQLite
Description: SQL database engine
Version: $SQLITE_VERSION
Libs: -L\${libdir} -lsqlite3
Cflags: -I\${includedir}
PCEOF

# --- CLI (legacy-only) ---
if [ "$BUILD_CLI" = "1" ]; then
    echo "==> Building sqlite3 CLI..."
    mkdir -p "$INSTALL_DIR/bin"
    # shellcheck disable=SC2086
    wasm32posix-cc $SQLITE_CFLAGS \
        "$SRC_DIR/shell.c" "$SRC_DIR/sqlite3.c" \
        -o "$INSTALL_DIR/bin/sqlite3.wasm" -lm

    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary sqlite "$INSTALL_DIR/bin/sqlite3.wasm"
fi

if [ -f "$INSTALL_DIR/lib/libsqlite3.a" ]; then
    echo "==> SQLite build complete!"
    ls -lh "$INSTALL_DIR/lib/libsqlite3.a"
    if [ "$BUILD_CLI" = "1" ]; then
        ls -lh "$INSTALL_DIR/bin/sqlite3.wasm"
    fi
else
    echo "ERROR: Build failed — library not found" >&2
    exit 1
fi
