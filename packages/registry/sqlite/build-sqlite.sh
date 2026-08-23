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
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
case "$TARGET_ARCH" in
    wasm32|wasm64) ;;
    *) echo "ERROR: unsupported SQLite architecture: $TARGET_ARCH" >&2; exit 2 ;;
esac
kandelo_package_prepare_build_roots "$SCRIPT_DIR/sqlite-work" "$TARGET_ARCH"

# --- Resolver contract (with legacy fallbacks) ---
SQLITE_VERSION="${WASM_POSIX_DEP_VERSION:-${SQLITE_VERSION:-3.49.1}}"
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/source"
BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/build"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/sqlite-install}"
# Legacy default URL uses the packed version form (3.49.1 → 3490100).
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-6cebd1d8403fc58c30e93939b246f3e6e58d0765a5cd50546f16c00fd805d2c3}"
SQLITE_MAX_COMPOUND_SELECT="${SQLITE_MAX_COMPOUND_SELECT:-50}"
SQLITE_MAX_EXPR_DEPTH="${SQLITE_MAX_EXPR_DEPTH:-100}"
SQLITE_JSON_MAX_DEPTH="${SQLITE_JSON_MAX_DEPTH:-100}"
SQLITE_MAX_TRIGGER_DEPTH="${SQLITE_MAX_TRIGGER_DEPTH:-50}"

# CLI is a consumer artifact, not a library. Skip it when invoked via
# the resolver — it would waste cache space and the consumer-side
# tooling will build it independently.
BUILD_CLI=1
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    BUILD_CLI=0
    requested_status=0
    kandelo_package_vfs_output_requested sqlite3 || requested_status=$?
    case "$requested_status" in
        0) BUILD_CLI=1 ;;
        1) ;;
        *) exit "$requested_status" ;;
    esac
fi

CC="${TARGET_ARCH}posix-cc"
AR="${TARGET_ARCH}posix-ar"
if ! command -v "$CC" &>/dev/null || ! command -v "$AR" &>/dev/null; then
    echo "ERROR: $TARGET_ARCH Kandelo SDK tools are unavailable." >&2
    exit 1
fi

# --- Stage the resolver-verified source without mutating it. ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified SQLite $SQLITE_VERSION source..."
    kandelo_package_stage_verified_source sqlite "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi
for required_source in sqlite3.c sqlite3.h sqlite3ext.h shell.c; do
    [ -s "$SRC_DIR/$required_source" ] || {
        echo "ERROR: verified SQLite source omits $required_source" >&2
        exit 1
    }
done

# Browser and Node Wasm engines exhaust their host stacks before SQLite's
# default recursive SQL limits are reached. Keep the shipped library and the
# official testfixture on the same supported limits.
SQLITE_CFLAGS="-O2 \
    -DSQLITE_OMIT_LOAD_EXTENSION \
    -DSQLITE_THREADSAFE=1 \
    -DSQLITE_DEFAULT_SYNCHRONOUS=0 \
    -DSQLITE_ENABLE_SETLK_TIMEOUT=2 \
    -DSQLITE_MAX_COMPOUND_SELECT=$SQLITE_MAX_COMPOUND_SELECT \
    -DSQLITE_MAX_EXPR_DEPTH=$SQLITE_MAX_EXPR_DEPTH \
    -DSQLITE_JSON_MAX_DEPTH=$SQLITE_JSON_MAX_DEPTH \
    -DSQLITE_MAX_TRIGGER_DEPTH=$SQLITE_MAX_TRIGGER_DEPTH \
    -DHAVE_PREAD=1 \
    -DHAVE_PWRITE=1 \
    -DSQLITE_ENABLE_FTS5 \
    -DSQLITE_ENABLE_JSON1 \
    -DSQLITE_ENABLE_MATH_FUNCTIONS \
    -DSQLITE_ENABLE_COLUMN_METADATA"

# --- Compile library ---
echo "==> Compiling SQLite for Wasm..."
mkdir -p "$BUILD_DIR"
# shellcheck disable=SC2086
"$CC" -c $SQLITE_CFLAGS \
    "$SRC_DIR/sqlite3.c" -o "$BUILD_DIR/sqlite3.o"

"$AR" rcs "$BUILD_DIR/libsqlite3.a" "$BUILD_DIR/sqlite3.o"

# --- Install library into INSTALL_DIR ---
echo "==> Installing to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include" "$INSTALL_DIR/lib/pkgconfig"

cp "$SRC_DIR/sqlite3.h" "$SRC_DIR/sqlite3ext.h" "$INSTALL_DIR/include/"
cp "$BUILD_DIR/libsqlite3.a" "$INSTALL_DIR/lib/"

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
    "$CC" $SQLITE_CFLAGS \
        "$SRC_DIR/shell.c" "$SRC_DIR/sqlite3.c" \
        -o "$INSTALL_DIR/bin/sqlite3.wasm" -lm

    if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        source "$REPO_ROOT/scripts/install-local-binary.sh"
        install_local_binary sqlite "$INSTALL_DIR/bin/sqlite3.wasm"
    fi
fi

kandelo_package_project_requested_vfs_output \
    sqlite3 "$INSTALL_DIR/bin/sqlite3.wasm"
kandelo_package_project_requested_vfs_directory_output \
    development-files "$SRC_DIR"

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
