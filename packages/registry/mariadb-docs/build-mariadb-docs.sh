#!/usr/bin/env bash
# Ship the `mariadb` package's upstream manual pages as mariadb-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (mariadb, and mysql as an alias of it) are shipped.
# mysql.1 is the MariaDB client's page (its title is MARIADB). The image
# installs only the client.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

install_package_man_pages mariadb-docs "$SRC" \
    man/mysql.1 \
    mariadb.1=mysql.1
