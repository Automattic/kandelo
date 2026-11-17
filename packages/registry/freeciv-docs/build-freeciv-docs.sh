#!/usr/bin/env bash
# Ship the `freeciv` package's manual pages as freeciv-docs.zip, a lazy
# archive mounted at /usr/.
#
# Upstream's pages are templates (doc/man/*.6.in) that its build fills in
# with the project's homepage, bug tracker, mailing list and data
# subdirectory. The freeciv package builds with meson, whose
# configure_file fills them with C-quoted strings
# (`.UR ""https://www.freeciv.org/""`), so mandoc drops the links and the
# pages show stray quotes. Upstream's autotools build fills the same
# templates from the same sources (bootstrap/freeciv.project, fc_version,
# configure.ac) without the quotes, so this runs that build's configure
# for the build machine, with every program disabled since only
# config.status's page substitution is used, and ships its pages.
#
# Pages shipped are those of what the image installs: freeciv(6), the
# overview; freeciv-server(6); freeciv-sdl2(6), the client the freeciv and
# freeciv-sdl2 commands run, and freeciv-client(6), which that page
# includes. The other clients, the modpack installer, ruledit, ruleup and
# freeciv-manual are not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
WORK="$KANDELO_PACKAGE_WORK_DIR"

BUILD="$WORK/freeciv-autotools"
rm -rf "$BUILD"
mkdir -p "$BUILD"
(
    cd "$BUILD"
    CC=cc "$SRC/configure" \
        --enable-client=no --disable-server --disable-fcmp \
        --disable-ruledit --disable-freeciv-manual \
        --disable-nls --without-readline \
        > "$WORK/configure.log" 2>&1 || { tail -40 config.log >&2; exit 1; }
)

# freeciv-sdl2.6 is not a template: upstream's `.so man6/freeciv-client.6`
# stub, installed as is.
cp "$SRC/doc/man/freeciv-sdl2.6" "$BUILD/doc/man/freeciv-sdl2.6"
install_package_man_pages freeciv-docs "$BUILD/doc/man" \
    freeciv.6 \
    freeciv-client.6 \
    freeciv-sdl2.6 \
    freeciv-server.6
