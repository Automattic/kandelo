#!/usr/bin/env bash
# Ship the `sysklogd` package's upstream manual pages as
# sysklogd-docs.zip, a lazy archive mounted at /usr/: syslogd(8), the one
# program the package builds, and syslog.conf(5), the file it reads.
# logger(1) is not shipped: the package builds --without-logger, and the
# image's logger is toybox's.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages sysklogd-docs "$SRC" \
    man/syslogd.8 \
    man/syslog.conf.5
