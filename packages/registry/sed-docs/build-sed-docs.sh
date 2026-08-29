#!/usr/bin/env bash
# Generate sed's man page(s) from the REAL sed wasm binary running
# inside a Kandelo kernel instance, then format with host help2man. See
# CLAUDE.md "Platform Values Contract" and scripts/manpage-docs-lib.sh: the
# page BODY is the binary's captured --help/--version; help2man only reformats
# it. The NAME lines are the tools' canonical upstream man-page NAMEs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/manpage-docs-lib.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"

DEP_DIR="${WASM_POSIX_DEP_SED_DIR:?sed dependency dir required}"
command -v help2man >/dev/null || { echo "help2man not on PATH" >&2; exit 2; }

CAP="$WORK/help-capture"
STAGE="$WORK/stage"; rm -rf "$STAGE"
WRAP="$WORK/wrap"; rm -rf "$WRAP"
SRC_LABEL="GNU sed 4.9 (Kandelo)"

SED_WASM="$(manpage_docs_find_wasm "$DEP_DIR" sed.wasm)"

manpage_docs_capture "$CAP" "$SED_WASM" sed

manpage_docs_emit_page sed 1 "stream editor for filtering and transforming text" "$SRC_LABEL" "$CAP" "$STAGE" "$WRAP"

[ -f "$STAGE/share/man/man1/sed.1" ] || { echo "sed.1 not generated" >&2; exit 2; }
manpage_docs_finalize "$STAGE" "$WORK" sed-docs sed-docs.zip
