#!/usr/bin/env bash
# Ship the `file` package's upstream manual pages as file-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (file, reading /usr/share/misc/magic) are shipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

# Upstream's doc/Makefile.am generates file.1 and magic.$(fsect) from
# the .man templates with exactly these four substitutions.
#
# fsect is the section for file formats. configure.ac defaults it to 4,
# the System V numbering; --enable-fsect-man5 selects 5, the BSD and
# Linux numbering, where section 4 means devices. The flag is read only
# by doc/Makefile.am, so it changes where the page lives and file.1's
# cross-references, never the file binary. Kandelo follows the Linux
# numbering its other pages use (nanorc.5, man.conf.5, gemfile.5), so
# magic(5) is installed here without reconfiguring the file package.
#
# The SDK's default --prefix=/usr makes MAGIC /usr/share/misc/magic,
# where the image installs the database.
for page in file:1 magic:5; do
    kandelo_man_pages_substitute "$SRC/doc/${page%%:*}.man" \
        "$SRC/doc/${page%%:*}.${page#*:}" \
        '__CSECTION__=1' '__FSECTION__=5' \
        "__VERSION__=$WASM_POSIX_DEP_VERSION" \
        '__MAGIC__=/usr/share/misc/magic'
done

install_package_man_pages file-docs "$SRC" \
    doc/file.1 \
    doc/magic.5
