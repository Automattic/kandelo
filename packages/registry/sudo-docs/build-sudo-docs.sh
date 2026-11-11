#!/usr/bin/env bash
# Ship the `sudo` package's manual pages as sudo-docs.zip, a lazy archive
# mounted at /usr/.
#
# Upstream's pages are templates (docs/*.mdoc.in) that config.status fills
# in with the configured paths and defaults. This configures sudo exactly
# as build-sudo.sh does, through the shared sudo/configure.sh, and runs
# docs/Makefile's rules for the pages of what the image installs: sudo(8)
# and the files it reads, sudo.conf(5), sudoers(5) (the sudoers policy
# sudo is built with) and sudoers_timestamp(5). The other programs sudo
# builds (visudo, cvtsudoers, sudoreplay) and sudoedit are not installed,
# so their pages are not shipped; sections follow install-doc.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
WORK="$KANDELO_PACKAGE_WORK_DIR"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
SDK_ROOT="$(cd "$(dirname "$(command -v wasm32posix-configure)")/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/packages/registry/sudo/configure.sh"

BUILD="$WORK/sudo-build"
rm -rf "$BUILD"
mkdir -p "$BUILD"
(
    cd "$BUILD"
    sudo_configure "$SRC" "$WORK" "$SDK_ROOT" > "$WORK/configure.log" 2>&1 || {
        tail -40 config.log >&2
        exit 1
    }
    sections="$(make -s -C docs -f - print-sections <<'MK'
include Makefile
print-sections:
	@echo $(mantype) $(mansectsu) $(mansectform)
MK
)"
    [ "$sections" = "mdoc 8 5" ] || {
        echo "build-sudo-docs: expected mdoc pages in sections 8 and 5, got: $sections" >&2
        exit 1
    }
    make -C docs ./sudo.mdoc ./sudo.conf.mdoc ./sudoers.mdoc ./sudoers_timestamp.mdoc \
        > "$WORK/make-doc.log" 2>&1 || { tail -40 "$WORK/make-doc.log" >&2; exit 1; }
)

install_package_man_pages sudo-docs "$BUILD/docs" \
    sudo.mdoc:sudo.8 \
    sudo.conf.mdoc:sudo.conf.5 \
    sudoers.mdoc:sudoers.5 \
    sudoers_timestamp.mdoc:sudoers_timestamp.5
