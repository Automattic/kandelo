#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
source "$repo/scripts/install-package-man-pages.sh"

work="$KANDELO_PACKAGE_WORK_DIR"
version="${WASM_POSIX_DEP_VERSION:-$(python3 -I -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["version"])' "$here/package.toml")}"
page_date="$(kandelo_man_pages_release_date "$version" 0.7.0-dev.20261009=2026-10-09)"
programs="${WASM_POSIX_DEP_ZIGCLI_DIR:?zigcli dependency dir required}"
spec="$work/help-capture.json"
python3 -I - "$programs" > "$spec" <<'PYTHON'
import json
import sys

commands = ["tree", "loc", "hexdump"]
json.dump({
    "files": [{"from": f"{sys.argv[1]}/{name}.wasm", "to": f"/usr/bin/{name}"} for name in commands],
    "commands": [{"name": name, "path": f"/usr/bin/{name}"} for name in commands],
}, sys.stdout)
PYTHON

capture="$work/help-capture"
kandelo_man_pages_capture_help "$spec" "$capture"
export SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$page_date")"

pages="$work/pages"
for program in tree loc hexdump; do
    # Zigcli prints a shared multiline version banner. Verify it and give
    # help2man's title line the version reported by the guest.
    rg -Fxq -- " - version: $version" "$capture/$program.version"
    case "$program" in
        tree) summary="display a directory tree" ;;
        loc) summary="count lines of code" ;;
        hexdump) summary="display file contents in hexadecimal" ;;
    esac
    kandelo_man_pages_help2man "$capture" "$program" "$pages/$program.1" \
        --name="$summary" --version-string="$version"
done
install_package_man_pages zigcli-docs "$pages" tree.1 loc.1 hexdump.1
