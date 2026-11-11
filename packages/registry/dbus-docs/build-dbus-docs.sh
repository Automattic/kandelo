#!/usr/bin/env bash
# Ship the `dbus` package's manual page for dbus-daemon, the one dbus
# command the image installs, as dbus-docs.zip, a lazy archive mounted at
# /usr/.
#
# Upstream writes its pages in DocBook. configure fills in the template
# (doc/dbus-daemon.1.xml.in) and doc/Makefile.am runs `xmlto man` over
# the result. This does the same with the directories build-dbus.sh
# configures dbus with, scripts/xmlto-man.sh for xmlto, and the DocBook
# DTD the page declares (it uses the DTD's entities). The page has no
# date of its own, so release-date.xsl dates it with the release date
# instead of the build clock.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
WORK="$KANDELO_PACKAGE_WORK_DIR"
VERSION="$WASM_POSIX_DEP_VERSION"
DATE="$(kandelo_man_pages_release_date "$VERSION" 1.14.10=2023-09-01)"

# The page states these directories; fail if dbus stops being configured
# with them.
DBUS_BUILD="$REPO_ROOT/packages/registry/dbus/build-dbus.sh"
for flag in --prefix=/usr --sysconfdir=/etc; do
    grep -qE "^[[:space:]]+$flag \\\\\$" "$DBUS_BUILD" || {
        echo "build-dbus-docs: build-dbus.sh no longer configures $flag" >&2
        exit 1
    }
done

XSL="$WORK/docbook-xsl"
DTD="$WORK/docbook-xml"
kandelo_package_stage_source_dependency docbook-xsl-source "$XSL" "$WORK"
kandelo_package_stage_source_dependency docbook-xml-source "$DTD" "$WORK"

OUT="$SRC/kandelo-man"
mkdir -p "$OUT"
# configure's values: EXPANDED_DATADIR is $prefix/share.
kandelo_man_pages_substitute "$SRC/doc/dbus-daemon.1.xml.in" "$OUT/dbus-daemon.1.xml" \
    "@DBUS_VERSION@=$VERSION" \
    @EXPANDED_DATADIR@=/usr/share \
    @EXPANDED_SYSCONFDIR@=/etc
(
    cd "$OUT"
    DOCBOOK_XSL="$XSL" XML_CATALOG_FILES="$DTD/catalog.xml" \
        "$REPO_ROOT/scripts/xmlto-man.sh" -m "$HERE/release-date.xsl" \
        --stringparam "kandelo.release.date=$DATE" man dbus-daemon.1.xml
)

install_package_man_pages dbus-docs "$SRC" kandelo-man/dbus-daemon.1
