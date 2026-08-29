#!/usr/bin/env bash
# Generate diffutils's man page(s) from the REAL diffutils wasm binary running
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

DEP_DIR="${WASM_POSIX_DEP_DIFFUTILS_DIR:?diffutils dependency dir required}"
command -v help2man >/dev/null || { echo "help2man not on PATH" >&2; exit 2; }

CAP="$WORK/help-capture"
STAGE="$WORK/stage"; rm -rf "$STAGE"
WRAP="$WORK/wrap"; rm -rf "$WRAP"
SRC_LABEL="GNU diffutils 3.10 (Kandelo)"

DIFF_WASM="$(manpage_docs_find_wasm "$DEP_DIR" diff.wasm)"
CMP_WASM="$(manpage_docs_find_wasm "$DEP_DIR" cmp.wasm)"
DIFF3_WASM="$(manpage_docs_find_wasm "$DEP_DIR" diff3.wasm)"
SDIFF_WASM="$(manpage_docs_find_wasm "$DEP_DIR" sdiff.wasm)"

manpage_docs_capture "$CAP" "$DIFF_WASM" diff "$CMP_WASM" cmp "$DIFF3_WASM" diff3 "$SDIFF_WASM" sdiff

manpage_docs_emit_page diff 1 "compare files line by line" "$SRC_LABEL" "$CAP" "$STAGE" "$WRAP"
manpage_docs_emit_page cmp 1 "compare two files byte by byte" "$SRC_LABEL" "$CAP" "$STAGE" "$WRAP"
manpage_docs_emit_page diff3 1 "compare three files line by line" "$SRC_LABEL" "$CAP" "$STAGE" "$WRAP"
manpage_docs_emit_page sdiff 1 "side-by-side merge of file differences" "$SRC_LABEL" "$CAP" "$STAGE" "$WRAP"

[ -f "$STAGE/share/man/man1/diff.1" ] || { echo "diff.1 not generated" >&2; exit 2; }
manpage_docs_finalize "$STAGE" "$WORK" diffutils-docs diffutils-docs.zip
