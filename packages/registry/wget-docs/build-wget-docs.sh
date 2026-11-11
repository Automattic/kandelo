#!/usr/bin/env bash
# Ship wget's manual page as wget-docs.zip, a lazy archive mounted at /usr/.
# wget writes its manual in Texinfo; its build turns doc/wget.texi into
# wget.1 with doc/texi2pod.pl and pod2man. These are the rules from
# doc/Makefile.am, with the page dated from the release date in
# doc/version.texi rather than the build clock.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
VERSION="$WASM_POSIX_DEP_VERSION"

(
    cd "$SRC/doc"
    grep -qx "@set VERSION $VERSION" version.texi || {
        echo "build-wget-docs: version.texi does not describe $VERSION" >&2; exit 1; }
    POD_MAN_DATE="$(perl -MTime::Piece -ne \
        'print Time::Piece->strptime($1, "%d %B %Y")->ymd if /^\@set UPDATED (\d+ \w+ \d{4})$/' \
        version.texi)"
    [ -n "$POD_MAN_DATE" ] || { echo "build-wget-docs: no release date in version.texi" >&2; exit 1; }
    export POD_MAN_DATE
    sed s/@/@@/g sample.wgetrc > sample.wgetrc.munged_for_texi_inclusion
    perl texi2pod.pl -D VERSION="$VERSION" wget.texi wget.pod
    pod2man --center="GNU Wget" --release="GNU Wget $VERSION" --utf8 wget.pod > wget.1
)

install_package_man_pages wget-docs "$SRC" \
    doc/wget.1
