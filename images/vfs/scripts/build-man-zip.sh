#!/usr/bin/env bash
#
# Build man.zip for the browser shell demo: a root-relative archive of
# bin/mandoc (the interpreter), bin/man (a symlink to mandoc), and
# etc/man.conf. The shell overlay mounts it at /usr/, so entries become
# /usr/bin/mandoc, /usr/bin/man, and /usr/etc/man.conf.
#
#   build-man-zip.sh <mandoc-dependency-dir> <output.zip>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ "$#" -eq 2 ] || { echo "usage: $0 <mandoc-dependency-dir> <output.zip>" >&2; exit 2; }
MANDOC_DIR="$1"
OUTPUT_FILE="$2"

[ -f "$MANDOC_DIR/mandoc.wasm" ] || { echo "mandoc.wasm not found under $MANDOC_DIR" >&2; exit 1; }

STAGING="$(mktemp -d "${WASM_POSIX_DEP_WORK_DIR:-/tmp}/man-zip.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/bin" "$STAGING/etc"

echo "==> Staging man.zip tree..."
# The interpreter as bin/mandoc (no .wasm extension).
cp "$MANDOC_DIR/mandoc.wasm" "$STAGING/bin/mandoc"
chmod 755 "$STAGING/bin/mandoc"
# man/apropos/whatis/makewhatis are all mandoc, dispatched by argv[0].
for alias in man apropos whatis makewhatis; do
    ln -s mandoc "$STAGING/bin/$alias"
done
printf 'manpath /usr/share/man\n' > "$STAGING/etc/man.conf"

# Exactly one regular executable named bin/mandoc is required by the loader.
[ -f "$STAGING/bin/mandoc" ] && [ ! -L "$STAGING/bin/mandoc" ] || {
    echo "bin/mandoc missing or not a regular file" >&2
    exit 1
}

OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"; mkdir -p "$OUTPUT_DIR"; rm -f "$OUTPUT_FILE"
bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"
echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"
