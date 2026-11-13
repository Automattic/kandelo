#!/usr/bin/env bash
# Ship the manual pages of the LLVM binary tools the `clang` package
# builds and the shell installs, as clang-docs.zip, a lazy archive
# mounted at /usr/.
#
# LLVM builds its pages from its command guide with Sphinx;
# scripts/llvm-command-guide-man-pages.sh runs the same command over the
# package's own LLVM source, dated with the release's date. The shell
# also installs these tools under their traditional names (ar, nm,
# strip, ...; images/vfs/lib/init/shell-binaries.ts), so each of those
# is a link to the page of the tool it runs. clang and wasm-ld are not
# in the shell and get no page here.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/llvm-command-guide-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
VERSION="$WASM_POSIX_DEP_VERSION"
DATE="$(kandelo_man_pages_release_date "$VERSION" 21.1.7=2025-12-02)"

OUT="$KANDELO_PACKAGE_WORK_DIR/sphinx-man"
kandelo_llvm_command_guide_man_pages "$KANDELO_MAN_PAGES_SOURCE" "$OUT" "$VERSION" "$DATE"
install_package_man_pages clang-docs "$OUT" \
    llvm-addr2line.1 llvm-ar.1 llvm-cxxfilt.1 llvm-nm.1 llvm-objcopy.1 \
    llvm-objdump.1 llvm-ranlib.1 llvm-readelf.1 llvm-readobj.1 llvm-size.1 \
    llvm-strings.1 llvm-strip.1 llvm-symbolizer.1 \
    addr2line.1=llvm-addr2line.1 ar.1=llvm-ar.1 c++filt.1=llvm-cxxfilt.1 \
    nm.1=llvm-nm.1 objcopy.1=llvm-objcopy.1 objdump.1=llvm-objdump.1 \
    ranlib.1=llvm-ranlib.1 size.1=llvm-size.1 strings.1=llvm-strings.1 \
    strip.1=llvm-strip.1
