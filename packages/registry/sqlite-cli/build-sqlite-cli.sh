#!/usr/bin/env bash
#
# Build the sqlite3 command-line client for wasm32-posix-kernel by
# linking the shell.c frontend against the sqlite library package's
# prebuilt libsqlite3.a. The amalgamation source is staged ONLY for
# shell.c; the engine comes from the resolved sqlite dependency.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"

TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: sqlite-cli is packaged for wasm32 only, got $TARGET_ARCH" >&2
    exit 2
fi
kandelo_package_prepare_build_roots "$SCRIPT_DIR/sqlite-cli-work" "$TARGET_ARCH"

# Worktree-local SDK on PATH.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
CC="${TARGET_ARCH}posix-cc"
if ! command -v "$CC" &>/dev/null; then
    echo "ERROR: $CC not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

# --- sqlite library dependency (depends_on = ["sqlite@3.49.1"]) ---
SQLITE_DIR="${WASM_POSIX_DEP_SQLITE_DIR:?resolver did not provide the sqlite dependency}"
if [ ! -f "$SQLITE_DIR/lib/libsqlite3.a" ]; then
    echo "ERROR: libsqlite3.a missing in $SQLITE_DIR/lib" >&2
    exit 1
fi

# --- Stage OUR source purely for shell.c (matches lib version 3.49.1). ---
SQLITE_VERSION="${WASM_POSIX_DEP_VERSION:-3.49.1}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-6cebd1d8403fc58c30e93939b246f3e6e58d0765a5cd50546f16c00fd805d2c3}"
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/source"
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified SQLite $SQLITE_VERSION source (for shell.c)..."
    kandelo_package_stage_verified_source sqlite-cli "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi
[ -s "$SRC_DIR/shell.c" ] || { echo "ERROR: shell.c missing from staged source" >&2; exit 1; }

# Keep the CLI feature-consistent with the shipped library. These match
# packages/registry/sqlite/build-sqlite.sh SQLITE_CFLAGS.
SQLITE_MAX_COMPOUND_SELECT="${SQLITE_MAX_COMPOUND_SELECT:-50}"
SQLITE_MAX_EXPR_DEPTH="${SQLITE_MAX_EXPR_DEPTH:-100}"
SQLITE_JSON_MAX_DEPTH="${SQLITE_JSON_MAX_DEPTH:-100}"
SQLITE_MAX_TRIGGER_DEPTH="${SQLITE_MAX_TRIGGER_DEPTH:-50}"
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

BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
mkdir -p "$BIN_DIR"
OUT="$BIN_DIR/sqlite3.wasm"

echo "==> Linking sqlite3 CLI against libsqlite3.a..."
# shellcheck disable=SC2086
"$CC" $SQLITE_CFLAGS \
    -I"$SQLITE_DIR/include" \
    "$SRC_DIR/shell.c" \
    -L"$SQLITE_DIR/lib" -lsqlite3 -lm \
    -Wl,-z,stack-size=1048576 -Wl,--export=__abi_version \
    -o "$OUT"

echo "==> Applying fork instrumentation (.shell/.system/.import fork)..."
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$OUT" -o "$OUT.instr"
mv "$OUT.instr" "$OUT"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
    if ! wasm_is_binary "$OUT"; then
        echo "ERROR: refusing non-Wasm sqlite3 artifact: $OUT" >&2
        exit 1
    fi
    wasm_require_no_legacy_asyncify "$OUT"
    wasm_require_fork_instrumentation_if_needed "$OUT"
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$OUT" "$WASM_POSIX_DEP_OUT_DIR/sqlite3.wasm"
    echo "  installed $WASM_POSIX_DEP_OUT_DIR/sqlite3.wasm (resolver scratch)"
else
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary sqlite-cli "$OUT"
fi

ls -lh "$OUT"
