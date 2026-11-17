#!/usr/bin/env bash
# Manual pages for wasm-fork-instrument, Kandelo's fork instrumentation tool, as wasm-fork-instrument-docs.zip, a lazy archive mounted at /usr/.
#
# The third tier of docs/porting-guide.md "Shipping man pages":
# kandelo_man_pages_capture_help runs each command inside Kandelo for --help
# and --version, and help2man lays out exactly what it printed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
OWNER="${WASM_POSIX_DEP_WASM_FORK_INSTRUMENT_DIR:?wasm-fork-instrument dependency dir required}"
# Kandelo's own tool has no release date; Kandelo's one fixed reference
# time dates its page.
EPOCH="$(sed -nE 's/^pub const KANDELO_REFERENCE_EPOCH_SECONDS: u64 = ([0-9_]+);$/\1/p' \
    "$REPO_ROOT/crates/shared/src/lib.rs" | tr -d _)"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "files": [
    {"from": "$OWNER/wasm-fork-instrument.wasm", "to": "/usr/bin/wasm-fork-instrument"}
  ],
  "env": ["PATH=/usr/bin:/bin", "HOME=/tmp"],
  "commands": [
    {"name": "wasm-fork-instrument", "path": "/usr/bin/wasm-fork-instrument"}
  ]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

# wasm-fork-instrument has no --version (it is part of every forking
# package's build, so its interface is not changed for this page); the
# package version is passed to help2man instead.
PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" wasm-fork-instrument "$PAGES/wasm-fork-instrument.1" \
    --source="Kandelo" \
    --version-string="wasm-fork-instrument (Kandelo wasm-fork-instrument) 0.1.0"
install_package_man_pages wasm-fork-instrument-docs "$PAGES" wasm-fork-instrument.1
