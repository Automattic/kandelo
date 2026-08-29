#!/usr/bin/env bash
# Generate findutils's man page(s) from the REAL findutils wasm binary running
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

DEP_DIR="${WASM_POSIX_DEP_FINDUTILS_DIR:?findutils dependency dir required}"
command -v help2man >/dev/null || { echo "help2man not on PATH" >&2; exit 2; }

CAP="$WORK/help-capture"
STAGE="$WORK/stage"; rm -rf "$STAGE"
WRAP="$WORK/wrap"; rm -rf "$WRAP"
SRC_LABEL="GNU findutils 4.10.0 (Kandelo)"

FIND_WASM="$(manpage_docs_find_wasm "$DEP_DIR" find.wasm)"
XARGS_WASM="$(manpage_docs_find_wasm "$DEP_DIR" xargs.wasm)"

manpage_docs_capture "$CAP" "$FIND_WASM" find "$XARGS_WASM" xargs

manpage_docs_emit_page find 1 "search for files in a directory hierarchy" "$SRC_LABEL" "$CAP" "$STAGE" "$WRAP"
manpage_docs_emit_page xargs 1 "build and execute command lines from standard input" "$SRC_LABEL" "$CAP" "$STAGE" "$WRAP"

[ -f "$STAGE/share/man/man1/find.1" ] || { echo "find.1 not generated" >&2; exit 2; }
manpage_docs_finalize "$STAGE" "$WORK" findutils-docs findutils-docs.zip
