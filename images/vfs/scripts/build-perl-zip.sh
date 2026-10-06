#!/usr/bin/env bash
#
# Build perl.zip for the browser shell demo: a root-relative archive of
# bin/perl (the interpreter) + lib/perl5/5.40.3 (the complete built standard
# library). The shell overlay mounts it at /usr/, so entries become
# /usr/bin/perl and /usr/lib/perl5/5.40.3/... — the latter is Perl's
# compiled-in @INC, so the interpreter self-locates every module.
#
# The stdlib comes from the perl package's perl-runtime.zip (produced by
# `make install.perl`), so it includes generated files (XSLoader.pm, Config.pm)
# and every core/dist/cpan/ext module — not a partial source scan.
#
#   build-perl-zip.sh <perl-dependency-dir> <output.zip>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ "$#" -eq 2 ] || { echo "usage: $0 <perl-dependency-dir> <output.zip>" >&2; exit 2; }
PERL_DIR="$1"
OUTPUT_FILE="$2"

# The perl package exposes its output (perl.wasm) and its runtime_files closure
# (perl-runtime.zip) directly in the dependency dir.
PERL_WASM="$PERL_DIR/perl.wasm"
RUNTIME_ZIP="$PERL_DIR/perl-runtime.zip"
[ -f "$PERL_WASM" ] || { echo "perl.wasm not found under $PERL_DIR" >&2; exit 1; }
[ -f "$RUNTIME_ZIP" ] || { echo "perl-runtime.zip not found under $PERL_DIR" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    STAGING="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/perl-zip.XXXXXX")"
else
    STAGING="$(mktemp -d)"
fi
trap 'rm -rf "$STAGING"' EXIT

echo "==> Extracting perl-runtime.zip..."
unzip -q "$RUNTIME_ZIP" -d "$STAGING"
# runtime zip is rooted at lib/perl5 (no usr/ prefix).
[ -d "$STAGING/lib/perl5" ] || { echo "runtime zip missing lib/perl5" >&2; exit 1; }

echo "==> Staging perl.zip tree..."
mkdir -p "$STAGING/bin"
# The interpreter as bin/perl (no .wasm extension).
cp "$PERL_WASM" "$STAGING/bin/perl"
chmod 755 "$STAGING/bin/perl"

# Exactly one regular executable named bin/perl is required by the loader.
[ -f "$STAGING/bin/perl" ] || { echo "bin/perl missing" >&2; exit 1; }

OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"; mkdir -p "$OUTPUT_DIR"; rm -f "$OUTPUT_FILE"
bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"
echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"
