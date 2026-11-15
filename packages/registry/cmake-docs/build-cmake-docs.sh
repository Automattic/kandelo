#!/usr/bin/env bash
# Ship CMake's manual pages as cmake-docs.zip, a lazy archive mounted at
# /usr/: cmake(1), ctest(1) and cpack(1), the commands the image installs,
# and the cmake-*(7) and cpack-generators(7) reference manuals they cite.
# ccmake and cmake-gui are not built, so their pages are not shipped.
#
# CMake writes its manuals in reStructuredText (Help/) and builds the
# pages with Sphinx through Utilities/Sphinx, configured standalone with
# SPHINX_MAN, as upstream's release build does. Sphinx dates the pages by
# SOURCE_DATE_EPOCH, set to the release's date.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
VERSION="$WASM_POSIX_DEP_VERSION"
DATE="$(kandelo_man_pages_release_date "$VERSION" 4.5.0=2026-11-12)"

BUILD="$KANDELO_PACKAGE_WORK_DIR/sphinx"
rm -rf "$BUILD"
LOG="$KANDELO_PACKAGE_WORK_DIR/sphinx.log"
{
    cmake -S "$SRC/Utilities/Sphinx" -B "$BUILD" \
        -DSPHINX_MAN=ON \
        -DSPHINX_EXECUTABLE="$(command -v sphinx-build)"
    SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$DATE")" \
        cmake --build "$BUILD"
} > "$LOG" 2>&1 || { tail -40 "$LOG" >&2; tail -40 "$BUILD/build-man.log" >&2 || true; exit 1; }

install_package_man_pages cmake-docs "$BUILD/man" \
    cmake.1 ctest.1 cpack.1 \
    cmake-buildsystem.7 cmake-commands.7 cmake-compile-features.7 \
    cmake-configure-log.7 cmake-cxxmodules.7 cmake-developer.7 \
    cmake-diagnostics.7 cmake-env-variables.7 cmake-file-api.7 \
    cmake-generator-expressions.7 cmake-generators.7 \
    cmake-instrumentation.7 cmake-language.7 cmake-modules.7 \
    cmake-packages.7 cmake-policies.7 cmake-presets.7 cmake-properties.7 \
    cmake-qt.7 cmake-server.7 cmake-toolchains.7 cmake-variables.7 \
    cpack-generators.7
