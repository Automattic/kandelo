#!/usr/bin/env bash
#
# Build the browser lazy-archive bundle for Perl. Reshapes the perl package's
# perl.wasm + perl-runtime.zip (the complete built standard library) into a
# root-relative perl.zip (bin/perl + lib/perl5/5.40.3/…). Consumers see the
# bare zip at programs/wasm32/perl.zip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-}"
PERL_DIR="${WASM_POSIX_DEP_PERL_DIR:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-}"

fail() { echo "build-perl-browser-bundle: $*" >&2; exit 2; }

require_real_directory() {
    local label="$1" path="$2"
    case "$path" in /*) ;; *) fail "$label must be an absolute resolver-owned directory: $path" ;; esac
    if [ ! -d "$path" ] || [ -L "$path" ]; then fail "$label must be a real directory: $path"; fi
}

[ "$TARGET_ARCH" = wasm32 ] || fail "browser bundle supports only wasm32"
require_real_directory WASM_POSIX_DEP_OUT_DIR "$OUT_DIR"
require_real_directory WASM_POSIX_DEP_WORK_DIR "$WORK_DIR"
require_real_directory WASM_POSIX_DEP_PERL_DIR "$PERL_DIR"

archive="$WORK_DIR/perl.zip"
bash "$REPO_ROOT/images/vfs/scripts/build-perl-zip.sh" "$PERL_DIR" "$archive"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary perl-browser-bundle "$archive" perl.zip
