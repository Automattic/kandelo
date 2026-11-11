#!/usr/bin/env bash
# Ship a manual page for redis-cli, the Redis command-line client, as
# redis-docs.zip, a lazy archive mounted at /usr/. (The shell does not
# install redis-server.)
#
# The program has no upstream manual page, so this is the third tier of
# docs/porting-guide.md "Shipping man pages": kandelo_man_pages_capture_help
# runs it inside Kandelo for --help and --version, and help2man lays out
# exactly what it printed. The page is dated with the release date of the
# source the program is built from.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
# The resolver passes the package version; a direct run reads the manifest.
VERSION="${WASM_POSIX_DEP_VERSION:-$(python3 -I -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["version"])' "$HERE/package.toml")}"
DATE="$(kandelo_man_pages_release_date "$VERSION" 7.2.5=2024-05-19)"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "files": [{"from": "${WASM_POSIX_DEP_REDIS_DIR:?}/redis-cli.wasm", "to": "/usr/bin/redis-cli"}],
  "commands": [{"name": "redis-cli", "path": "/usr/bin/redis-cli"}]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$DATE")" \
    kandelo_man_pages_help2man "$CAP" redis-cli "$PAGES/redis-cli.1" --source="Redis 7.2.5"
install_package_man_pages redis-docs "$PAGES" redis-cli.1
