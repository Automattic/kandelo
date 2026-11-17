#!/usr/bin/env bash
# Ship npm's manual pages as npm-docs.zip, a lazy archive mounted at /usr/.
#
# npm publishes its pages prebuilt in the package's man/ directory, and
# package.json's `directories.man` makes npm's own installer link every
# page there into the man path: npm and npx(1), one page per npm command
# (npm-install(1), ...), the files npm reads (npmrc(5), package-json(5),
# ...) and its guides (section 7). This ships that same set at
# /usr/share/man for man(1), and links each page into npm's own man
# directory (/usr/lib/npm/man), where `npm help` looks pages up.
# (`npm help` does not run in Kandelo yet: it loads
# node:readline/promises, which Kandelo's node does not provide.)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"

man_dir="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["directories"]["man"])' "$SRC/package.json")"
[ "$man_dir" = "./man" ] || { echo "build-npm-docs: npm's man directory is now $man_dir" >&2; exit 1; }

pages=()
while IFS= read -r page; do
    pages+=("man/$page")
done < <(cd "$SRC/man" && find . -type f -name '*.[1-9]' | sed 's#^\./##' | LC_ALL=C sort)
other="$(cd "$SRC/man" && find . -type f ! -name '*.[1-9]' | head -1)"
[ -z "$other" ] || { echo "build-npm-docs: unexpected file in man/: $other" >&2; exit 1; }
[ "${#pages[@]}" -gt 80 ] || { echo "build-npm-docs: only ${#pages[@]} pages" >&2; exit 1; }

specs=()
for page in "${pages[@]}"; do specs+=("$page:$(basename "$page")"); done
install_package_man_pages npm-docs "$SRC" "${specs[@]}" +lib/npm/man
