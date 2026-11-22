#!/usr/bin/env bash
# Ship a manual page for sqlite3, the SQLite command-line shell, as
# sqlite-cli-docs.zip, a lazy archive mounted at /usr/. The amalgamation
# sqlite3 is built from carries no manual page. sqlite3 prints its usage
# on standard error, so that is the stream captured. Its --version line
# omits the program name that help2man expects first, so help2man would
# take "3.49.1" for the name; the captured line is passed to help2man
# after the command's name instead.
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
DATE="$(kandelo_man_pages_release_date "$VERSION" 3.49.1=2025-02-18)"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "files": [{"from": "${WASM_POSIX_DEP_SQLITE_CLI_DIR:?}/sqlite3.wasm", "to": "/usr/bin/sqlite3"}],
  "commands": [{"name": "sqlite3", "path": "/usr/bin/sqlite3", "stream": "stderr"}]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$DATE")" \
    kandelo_man_pages_help2man "$CAP" sqlite3 "$PAGES/sqlite3.1" --source="SQLite 3.49.1" \
    --version-string="sqlite3 $(head -n 1 "$CAP/sqlite3.version")"
install_package_man_pages sqlite-cli-docs "$PAGES" sqlite3.1
