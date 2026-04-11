#!/usr/bin/env bash
set -euo pipefail

SQLITE_VERSION="${SQLITE_VERSION:-3490100}"  # 3.49.1
SQLITE_YEAR="${SQLITE_YEAR:-2025}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/sqlite-src"
INSTALL_DIR="$SCRIPT_DIR/sqlite-install"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# Download amalgamation if not present
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading SQLite $SQLITE_VERSION..."
    curl -fsSL "https://www.sqlite.org/$SQLITE_YEAR/sqlite-amalgamation-$SQLITE_VERSION.zip" \
        -o /tmp/sqlite.zip
    mkdir -p "$SRC_DIR"
    unzip -o /tmp/sqlite.zip -d "$SRC_DIR"
    mv "$SRC_DIR/sqlite-amalgamation-$SQLITE_VERSION"/* "$SRC_DIR/"
    rmdir "$SRC_DIR/sqlite-amalgamation-$SQLITE_VERSION"
    rm /tmp/sqlite.zip
fi

SQLITE_CFLAGS="-O2 \
    -DSQLITE_OMIT_LOAD_EXTENSION \
    -DSQLITE_THREADSAFE=0 \
    -DSQLITE_OMIT_WAL \
    -DSQLITE_DEFAULT_SYNCHRONOUS=0 \
    -DSQLITE_ENABLE_FTS5 \
    -DSQLITE_ENABLE_JSON1 \
    -DSQLITE_ENABLE_MATH_FUNCTIONS"

echo "==> Compiling SQLite for Wasm..."
# shellcheck disable=SC2086
wasm32posix-cc -c $SQLITE_CFLAGS \
    "$SRC_DIR/sqlite3.c" -o "$SRC_DIR/sqlite3.o"

wasm32posix-ar rcs "$SRC_DIR/libsqlite3.a" "$SRC_DIR/sqlite3.o"

# Install to local install dir (same pattern as OpenSSL)
echo "==> Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include" "$INSTALL_DIR/lib/pkgconfig"

cp "$SRC_DIR/sqlite3.h" "$SRC_DIR/sqlite3ext.h" "$INSTALL_DIR/include/"
cp "$SRC_DIR/libsqlite3.a" "$INSTALL_DIR/lib/"

# Create pkg-config file
cat > "$INSTALL_DIR/lib/pkgconfig/sqlite3.pc" <<PCEOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: SQLite
Description: SQL database engine
Version: 3.49.1
Libs: -L\${libdir} -lsqlite3
Cflags: -I\${includedir}
PCEOF

# Build sqlite3 CLI binary
echo "==> Building sqlite3 CLI..."
mkdir -p "$INSTALL_DIR/bin"
# shellcheck disable=SC2086
wasm32posix-cc $SQLITE_CFLAGS \
    "$SRC_DIR/shell.c" "$SRC_DIR/sqlite3.c" \
    -o "$INSTALL_DIR/bin/sqlite3.wasm" -lm

if [ -f "$INSTALL_DIR/lib/libsqlite3.a" ] && [ -f "$INSTALL_DIR/bin/sqlite3.wasm" ]; then
    echo "==> SQLite build complete!"
    ls -lh "$INSTALL_DIR/lib/libsqlite3.a"
    ls -lh "$INSTALL_DIR/bin/sqlite3.wasm"
else
    echo "ERROR: Build failed — library or binary not found" >&2
    exit 1
fi
