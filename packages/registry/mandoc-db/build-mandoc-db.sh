#!/usr/bin/env bash
# Build the combined mandoc.db index over every shipped -docs man page, so
# man's name lookup, apropos, whatis, and man -k work at runtime (and the
# "outdated mandoc.db, run makewhatis" note is gone).
#
# mandoc's dba database format is architecture-portable (fixed offsets, and
# both host and guest are little-endian), verified by booting the guest
# mandoc against a host-built db. So we build a HOST mandoc from the same
# pinned source as the guest mandoc package (guaranteeing an identical db
# format), run its makewhatis over the -docs pages, and ship the resulting
# mandoc.db. No Kandelo boot needed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"

# --- The -docs archives whose pages this indexes (from depends_on) ---
DOCS_DIRS=(
  "${WASM_POSIX_DEP_COREUTILS_DOCS_DIR:?coreutils-docs dependency dir required}"
  "${WASM_POSIX_DEP_LSOF_DOCS_DIR:?lsof-docs dependency dir required}"
)

# --- Host-build mandoc (for makewhatis) from the pinned source ---
MANDOC_VER="${WASM_POSIX_DEP_VERSION:-1.14.6}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://mandoc.bsd.lv/snapshots/mandoc-${MANDOC_VER}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-8bf0d570f01e70a6e124884088870cbed7537f36328d512909eb10cd53179d9c}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SRC="$WORK/mandoc-src"
rm -rf "$SRC"
kandelo_package_stage_verified_source mandoc-db "$SRC" \
    "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK"
(
  cd "$SRC"
  # makewhatis/apropos/whatis/man are all mandoc, dispatched by argv[0] — only
  # the `mandoc` binary is a build target.
  printf 'CC=cc\nCFLAGS="-O2 -w"\nPREFIX=%s/inst\n' "$WORK" > configure.local
  ./configure >/dev/null 2>&1 || { echo "mandoc-db: host mandoc configure failed" >&2; exit 2; }
  make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" mandoc >/dev/null 2>&1 \
      || { echo "mandoc-db: host mandoc build failed" >&2; exit 2; }
  cp mandoc makewhatis
)
HOST_MAKEWHATIS="$SRC/makewhatis"
[ -x "$HOST_MAKEWHATIS" ] || { echo "mandoc-db: host makewhatis missing" >&2; exit 2; }

# --- Assemble the manpath tree from every -docs archive ---
MANROOT="$WORK/manroot"; rm -rf "$MANROOT"; mkdir -p "$MANROOT/share/man"
for dir in "${DOCS_DIRS[@]}"; do
    zip="$(find "$dir" -maxdepth 1 -name '*-docs.zip' | head -1)"
    [ -f "$zip" ] || { echo "mandoc-db: no -docs.zip under $dir" >&2; exit 2; }
    tmp="$(mktemp -d "$WORK/docs.XXXXXX")"
    unzip -q "$zip" -d "$tmp"
    # archives are rooted at share/man/...
    cp -R "$tmp/share/man/." "$MANROOT/share/man/"
    rm -rf "$tmp"
done
pages="$(find "$MANROOT/share/man" -type f \( -name '*.[1-9]' \) | wc -l | tr -d ' ')"
echo "==> indexing $pages man pages"
[ "$pages" -gt 0 ] || { echo "mandoc-db: no man pages to index" >&2; exit 2; }

# Normalize page mtimes so makewhatis records a byte-deterministic db.
find "$MANROOT/share/man" -exec touch -t 200001010000.00 {} +

# --- Build the combined mandoc.db ---
"$HOST_MAKEWHATIS" "$MANROOT/share/man"
[ -f "$MANROOT/share/man/mandoc.db" ] || { echo "mandoc-db: makewhatis produced no db" >&2; exit 2; }
echo "==> mandoc.db: $(wc -c <"$MANROOT/share/man/mandoc.db" | tr -d ' ') bytes"

# --- Package just the db, rooted at share/man/ for a /usr/ mount ---
STAGE="$WORK/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE/share/man"
cp "$MANROOT/share/man/mandoc.db" "$STAGE/share/man/mandoc.db"
ARCHIVE="$WORK/mandoc-db.zip"; rm -f "$ARCHIVE"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$STAGE" "$ARCHIVE"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
        install_local_binary mandoc-db "$ARCHIVE" mandoc-db.zip
else
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
        install_local_binary mandoc-db "$ARCHIVE" mandoc-db.zip
fi
