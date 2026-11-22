#!/usr/bin/env bash
# Ship the `gettext` package's upstream manual pages as gettext-docs.zip,
# a lazy archive mounted at /usr/. Only pages for commands the image
# installs are shipped: the 22 programs in images/vfs/lib/init/dev-tools.ts
# and the autopoint, gettextize and po-fetch scripts in gettext-data.
# spit is not installed, and the section 3 pages describe GNU libintl,
# which Kandelo does not ship (musl provides the gettext functions).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

# gettext-runtime/man/Makefile fills in the message catalog directory,
# $(localedir): /usr/share/locale under the gettext package's
# --prefix=/usr.
kandelo_man_pages_substitute "$SRC/gettext-runtime/man/gettext.1.in" "$SRC/gettext-runtime/man/gettext.1" \
    "@localedir@=/usr/share/locale"
kandelo_man_pages_substitute "$SRC/gettext-runtime/man/ngettext.1.in" "$SRC/gettext-runtime/man/ngettext.1" \
    "@localedir@=/usr/share/locale"
kandelo_man_pages_substitute "$SRC/gettext-runtime/man/printf_gettext.1.in" "$SRC/gettext-runtime/man/printf_gettext.1" \
    "@localedir@=/usr/share/locale"
kandelo_man_pages_substitute "$SRC/gettext-runtime/man/printf_ngettext.1.in" "$SRC/gettext-runtime/man/printf_ngettext.1" \
    "@localedir@=/usr/share/locale"

install_package_man_pages gettext-docs "$SRC" \
    gettext-runtime/man/envsubst.1 \
    gettext-runtime/man/gettext.1 \
    gettext-runtime/man/ngettext.1 \
    gettext-runtime/man/printf_gettext.1 \
    gettext-runtime/man/printf_ngettext.1 \
    gettext-tools/man/autopoint.1 \
    gettext-tools/man/gettextize.1 \
    gettext-tools/man/msgattrib.1 \
    gettext-tools/man/msgcat.1 \
    gettext-tools/man/msgcmp.1 \
    gettext-tools/man/msgcomm.1 \
    gettext-tools/man/msgconv.1 \
    gettext-tools/man/msgen.1 \
    gettext-tools/man/msgexec.1 \
    gettext-tools/man/msgfilter.1 \
    gettext-tools/man/msgfmt.1 \
    gettext-tools/man/msggrep.1 \
    gettext-tools/man/msginit.1 \
    gettext-tools/man/msgmerge.1 \
    gettext-tools/man/msgpre.1 \
    gettext-tools/man/msgunfmt.1 \
    gettext-tools/man/msguniq.1 \
    gettext-tools/man/po-fetch.1 \
    gettext-tools/man/recode-sr-latin.1 \
    gettext-tools/man/xgettext.1
