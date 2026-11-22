#!/usr/bin/env bash
# Manual pages for rustfmt, cargo-fmt, cargo-clippy and clippy-driver, which the pinned Rust distribution ships without manual pages, as rust-tools-docs.zip, a lazy archive mounted at /usr/.
#
# The third tier of docs/porting-guide.md "Shipping man pages":
# kandelo_man_pages_capture_help runs each command inside Kandelo for --help
# and --version, and help2man lays out exactly what it printed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
WORK="$KANDELO_PACKAGE_WORK_DIR"
OWNER="${WASM_POSIX_DEP_RUSTC_DIR:?rustc dependency dir required}"
# The resolver passes the package version; a direct run reads the manifest.
VERSION="${WASM_POSIX_DEP_VERSION:-$(python3 -I -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["version"])' "$HERE/package.toml")}"
EPOCH="$(kandelo_man_pages_date_epoch "$(kandelo_man_pages_release_date "$VERSION" 1.97.0-nightly-2026-04-27=2026-04-27)")"

SPEC="$WORK/help-capture.json"
cat > "$SPEC" <<EOF
{
  "files": [
    {"from": "$OWNER/rustfmt.wasm", "to": "/usr/bin/rustfmt"},
    {"from": "$OWNER/cargo-fmt.wasm", "to": "/usr/bin/cargo-fmt"},
    {"from": "$OWNER/cargo-clippy.wasm", "to": "/usr/bin/cargo-clippy"},
    {"from": "$OWNER/clippy-driver.wasm", "to": "/usr/bin/clippy-driver"}
  ],
  "env": ["PATH=/usr/bin:/bin", "HOME=/tmp"],
  "commands": [
    {"name": "rustfmt", "path": "/usr/bin/rustfmt"},
    {"name": "cargo-fmt", "path": "/usr/bin/cargo-fmt"},
    {"name": "cargo-clippy", "path": "/usr/bin/cargo-clippy"},
    {"name": "clippy-driver", "path": "/usr/bin/clippy-driver"}
  ]
}
EOF
CAP="$WORK/help-capture"
kandelo_man_pages_capture_help "$SPEC" "$CAP"

# cargo-fmt reports rustfmt's version, and cargo-clippy and clippy-driver
# Clippy's ("clippy 0.1.97"); help2man would name those pages after the
# reporting tool, so each version is passed under the command's own name.
PAGES="$WORK/pages"
rm -rf "$PAGES"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" rustfmt "$PAGES/rustfmt.1" \
    --source="Rust 1.97.0-nightly"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" cargo-fmt "$PAGES/cargo-fmt.1" \
    --source="Rust 1.97.0-nightly" \
    --version-string="cargo-fmt (rustfmt) $(awk '{print $NF}' "$CAP/cargo-fmt.version")"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" cargo-clippy "$PAGES/cargo-clippy.1" \
    --source="Rust 1.97.0-nightly" \
    --version-string="cargo-clippy (clippy) $(awk '{print $NF}' "$CAP/cargo-clippy.version")"
SOURCE_DATE_EPOCH="$EPOCH" kandelo_man_pages_help2man "$CAP" clippy-driver "$PAGES/clippy-driver.1" \
    --source="Rust 1.97.0-nightly" \
    --version-string="clippy-driver (clippy) $(awk '{print $NF}' "$CAP/clippy-driver.version")"
install_package_man_pages rust-tools-docs "$PAGES" rustfmt.1 cargo-fmt.1 cargo-clippy.1 clippy-driver.1 cargo-fmt.wasm.1=cargo-fmt.1 cargo-clippy.wasm.1=cargo-clippy.1
