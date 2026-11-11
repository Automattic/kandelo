#!/usr/bin/env bash
# Ship a manual page for node, Kandelo's SpiderMonkey-based runtime, as
# node-docs.zip, a lazy archive mounted at /usr/. node runs from the
# node.zip tree the shell installs. Upstream Node.js's node.1 describes a
# different program, so this page comes from the binary itself.
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
# Kandelo's node is this repository's (version 0.1.0); the help text is
# the SpiderMonkey shell's, so the page carries that release's date.
SPIDERMONKEY=140.11.0esr
grep -qF "\"spidermonkey@$SPIDERMONKEY\"" "$REPO_ROOT/packages/registry/node/package.toml" || {
    echo "build-node-docs: node no longer builds on spidermonkey $SPIDERMONKEY" >&2
    exit 1
}
DATE="$(kandelo_man_pages_release_date "$SPIDERMONKEY" 140.11.0esr=2026-05-18)"

TREE="$WORK/node-tree"
rm -rf "$TREE"
mkdir -p "$TREE"
unzip -q "${WASM_POSIX_DEP_NODE_BROWSER_BUNDLE_DIR:?}/node.zip" -d "$TREE"
SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "trees": [{"from": "$TREE", "to": "/usr"}],
  "commands": [{"name": "node", "path": "/usr/bin/node"}]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$DATE")" \
    kandelo_man_pages_help2man "$CAP" node "$PAGES/node.1" --source="Kandelo node 0.1.0"
install_package_man_pages node-docs "$PAGES" node.1
