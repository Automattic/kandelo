#!/usr/bin/env bash
# Ship the `php` package's upstream manual pages as php-docs.zip, a
# lazy archive mounted at /usr/. Only pages for commands the image
# installs (php) are shipped.
# php-cgi, php-fpm, phpdbg, phar, phpize and php-config are not installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

# configure fills php.1.in from sapi/cli/config.m4. The php package
# configures without --program-prefix, so program_prefix is empty.
kandelo_man_pages_substitute "$SRC/sapi/cli/php.1.in" "$SRC/php.1" \
    '@program_prefix@=' "@PHP_VERSION@=$WASM_POSIX_DEP_VERSION"

install_package_man_pages php-docs "$SRC" \
    php.1
