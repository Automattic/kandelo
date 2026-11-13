#!/usr/bin/env bash
# Ship manual pages for libtool, libtoolize and libtool-next-version as
# libtool-docs.zip, a lazy archive mounted at /usr/.
#
# Libtool's tarball has pages, which its build makes with help2man from
# each script's --help. Those describe the maintainer's machine: libtool(1)
# and libtoolize(1) end with the configuration the scripts were built for
# (host x86_64-pc-linux-gnu, an ELF linker, the maintainer's Automake).
# Kandelo's libtool is configured for wasm32-unknown-linux-musl, so this
# recipe runs upstream's rule over Kandelo's scripts instead: each runs
# inside Kandelo as the shell installs it, and help2man lays out what it
# printed, with the names and options upstream's Makefile passes. The
# libtool, autoconf, automake and perl trees are at /usr, and bash (the
# scripts' shell), coreutils (env, for libtoolize's #!), sed and grep at
# the paths the scripts name, because the base rootfs keeps programs as
# lazy files the capture cannot fetch. The "automake:" and "autoconf:"
# lines are what Kandelo's own Automake and Autoconf report.
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
DATE="$(kandelo_man_pages_release_date "$VERSION" 2.6.2=2026-07-16)"

TREE="$WORK/usr-tree"
rm -rf "$TREE"
mkdir -p "$TREE"
for zip in \
    "${WASM_POSIX_DEP_LIBTOOL_DIR:?}/libtool.zip" \
    "${WASM_POSIX_DEP_AUTOCONF_DIR:?}/autoconf.zip" \
    "${WASM_POSIX_DEP_AUTOMAKE_DIR:?}/automake.zip" \
    "${WASM_POSIX_DEP_PERL_BROWSER_BUNDLE_DIR:?}/perl.zip"; do
    unzip -q -n "$zip" -d "$TREE"
done
SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<JSON
{
  "files": [
    {"from": "${WASM_POSIX_DEP_BASH_DIR:?}/bash.wasm", "to": "/bin/bash"},
    {"from": "${WASM_POSIX_DEP_COREUTILS_DIR:?}/coreutils.wasm", "to": "/bin/coreutils"},
    {"from": "${WASM_POSIX_DEP_SED_DIR:?}/sed.wasm", "to": "/bin/sed"},
    {"from": "${WASM_POSIX_DEP_GREP_DIR:?}/grep.wasm", "to": "/bin/grep"}
  ],
  "trees": [{"from": "$TREE", "to": "/usr"}],
  "env": ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp"],
  "commands": [
    {"name": "libtool", "path": "/usr/bin/libtool", "help": ["--help-all"]},
    {"name": "libtoolize", "path": "/usr/bin/libtoolize"},
    {"name": "libtool-next-version", "path": "/usr/bin/libtool-next-version"}
  ]
}
JSON
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

PAGES="$WORK/pages"
rm -rf "$PAGES"
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH="$(kandelo_man_pages_date_epoch "$DATE")"
# The -n names are the ones libtool's Makefile.in passes (update_mans).
kandelo_man_pages_help2man "$CAP" libtool "$PAGES/libtool.1" \
    -n 'Provide generalized library-building support services'
kandelo_man_pages_help2man "$CAP" libtoolize "$PAGES/libtoolize.1" \
    -n 'Prepare a package to use libtool'
kandelo_man_pages_help2man "$CAP" libtool-next-version "$PAGES/libtool-next-version.1" \
    -n 'Determines next version to use for a libtool library'
install_package_man_pages libtool-docs "$PAGES" \
    libtool.1 libtoolize.1 libtool-next-version.1
