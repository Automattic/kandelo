#!/usr/bin/env bash
# Generate grep(1)'s man page from the REAL grep.wasm binary running inside a
# Kandelo kernel instance, then format with host help2man. See CLAUDE.md
# "Platform Values Contract" and scripts/manpage-docs-lib.sh: the page BODY is
# grep's captured --help/--version; help2man only reformats it. The NAME line
# is grep's canonical upstream man-page NAME (metadata).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/manpage-docs-lib.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"

GREP_DIR="${WASM_POSIX_DEP_GREP_DIR:?grep dependency dir required}"
GREP_WASM="$(manpage_docs_find_wasm "$GREP_DIR" grep.wasm)"
command -v help2man >/dev/null || { echo "help2man not on PATH" >&2; exit 2; }

CAP="$WORK/help-capture"
STAGE="$WORK/stage"; rm -rf "$STAGE"
WRAP="$WORK/wrap"; rm -rf "$WRAP"
SRC_LABEL="GNU grep ${WASM_POSIX_DEP_VERSION:-3.11} (Kandelo)"

manpage_docs_capture "$CAP" "$GREP_WASM" grep
manpage_docs_emit_page grep 1 "print lines that match patterns" \
    "$SRC_LABEL" "$CAP" "$STAGE" "$WRAP"

[ -f "$STAGE/share/man/man1/grep.1" ] || { echo "grep.1 not generated" >&2; exit 2; }
manpage_docs_finalize "$STAGE" "$WORK" grep-docs grep-docs.zip
