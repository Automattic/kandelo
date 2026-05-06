#!/usr/bin/env bash
set -euo pipefail

# Bundle the Vim runtime for the browser shell demo (and any other
# host that runs vim.wasm).
#
# Strategy: ship the full upstream runtime/ tree — the same set of
# files `apt install vim-runtime` lays down under
# /usr/share/vim/vim<ver>/ — minus a small denylist of pieces that
# have no use in this environment:
#
#   1. Upstream test fixtures (~4 MB).
#      syntax/testdir, syntax/generator, indent/testdir exist for
#      Vim's own `make test_syntax`. They aren't loaded at runtime
#      and aren't shipped by distro packages.
#
#   2. Encodings/locales we don't use (~5 MB).
#      The demo runs LANG=en_US.UTF-8, so non-utf-8 spell encodings,
#      non-English tutor files, and per-language spell dictionaries
#      are dead weight. lang/ is gettext .mo translations; vim is
#      built --disable-nls and won't read them.
#
#   3. Host-platform integration (~0.5 MB).
#      Icons, .desktop entries, PostScript print files, and host-side
#      Perl/shell tools are for desktop integration and :hardcopy
#      printing — neither applies in wasm-on-browser.
#
# Output: examples/libs/vim/runtime/ (directory tree)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/vim-src"
RUNTIME_SRC="$SRC_DIR/runtime"
RUNTIME_OUT="$SCRIPT_DIR/runtime"

if [ ! -d "$RUNTIME_SRC" ]; then
    echo "ERROR: Vim source not found. Run build-vim.sh first." >&2
    exit 1
fi

echo "==> Bundling Vim runtime..."

rm -rf "$RUNTIME_OUT"
mkdir -p "$RUNTIME_OUT"

# Sync the full runtime tree, excluding the bucket-1/2/3 items above.
# rsync trailing-slash semantics: "$RUNTIME_SRC/" copies the contents
# of runtime/ into RUNTIME_OUT/ (not runtime/ itself).
rsync -a \
    --exclude='syntax/testdir/' \
    --exclude='syntax/generator/' \
    --exclude='indent/testdir/' \
    --exclude='keymap/' \
    --exclude='lang/' \
    --exclude='print/' \
    --exclude='tools/' \
    --exclude='bitmaps/' \
    --exclude='icons/' \
    --exclude='*.png' \
    --exclude='*.gif' \
    --exclude='*.svg' \
    --exclude='*.xpm' \
    --exclude='*.eps' \
    --exclude='*.pdf' \
    --exclude='*.cdr' \
    --exclude='*.desktop' \
    --exclude='doc/version[0-9]*.txt' \
    --exclude='spell/en.latin1.spl' \
    --exclude='spell/en.latin1.sug' \
    --exclude='spell/en.ascii.spl' \
    --exclude='spell/en.ascii.sug' \
    --exclude='spell/en/' \
    "$RUNTIME_SRC/" "$RUNTIME_OUT/"

# Per-language spell dictionaries live in $lang/ subdirs and top-level
# $lang.{spl,sug} files. rsync's --exclude can't easily express
# "everything except en*", so prune after the copy.
if [ -d "$RUNTIME_OUT/spell" ]; then
    find "$RUNTIME_OUT/spell" -mindepth 1 -maxdepth 1 -type d ! -name 'en*' -exec rm -rf {} +
    find "$RUNTIME_OUT/spell" -mindepth 1 -maxdepth 1 -type f \
        ! -name 'en*' \
        ! -name 'README*' \
        ! -name '*.vim' \
        ! -name '*.aap' \
        -delete
fi

# Translated tutor files: tutor.<lang>[.<encoding>] and README.<lang>.*.
# Keep English (`tutor`, `tutor.utf-8`, `tutor2*`, `tutor.tutor*`,
# `tutor.vim`, `tutor.info`, the en/ dir, build scripts, README.txt).
if [ -d "$RUNTIME_OUT/tutor" ]; then
    find "$RUNTIME_OUT/tutor" -mindepth 1 -maxdepth 1 -type f \
        ! -name 'tutor' \
        ! -name 'tutor.utf-8' \
        ! -name 'tutor.info' \
        ! -name 'tutor.vim' \
        ! -name 'tutor.tutor' \
        ! -name 'tutor.tutor.json' \
        ! -name 'tutor2' \
        ! -name 'tutor2.utf-8' \
        ! -name 'Make*' \
        ! -name 'README.txt' \
        ! -name 'README.txt.info' \
        -delete
fi

# Count files and total size
FILE_COUNT=$(find "$RUNTIME_OUT" -type f | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$RUNTIME_OUT" | cut -f1)

echo "==> Bundled $FILE_COUNT runtime files ($TOTAL_SIZE)"
echo "==> Output: $RUNTIME_OUT/"
