#!/usr/bin/env bash
# Ship the `rust-coverage-tools` package's manual pages, llvm-cov(1) and
# llvm-profdata(1), as rust-coverage-tools-docs.zip, a lazy archive
# mounted at /usr/.
#
# LLVM builds its pages from its command guide with Sphinx;
# scripts/llvm-command-guide-man-pages.sh runs the same command over the
# package's own LLVM source, and this ships the pages of the two commands
# the package installs, dated with the LLVM release's date.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/llvm-command-guide-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
VERSION="$WASM_POSIX_DEP_VERSION"
DATE="$(kandelo_man_pages_release_date "$VERSION" 22.1.2=2026-03-24)"

OUT="$KANDELO_PACKAGE_WORK_DIR/sphinx-man"
kandelo_llvm_command_guide_man_pages "$KANDELO_MAN_PAGES_SOURCE" "$OUT" "$VERSION" "$DATE"
install_package_man_pages rust-coverage-tools-docs "$OUT" llvm-cov.1 llvm-profdata.1
