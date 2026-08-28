#!/usr/bin/env bash
#
# Build the browser lazy-archive bundle for Ruby. Reshapes the ruby
# package's ruby.wasm + ruby-runtime.zip into a root-relative ruby.zip
# (bin/ruby + bin/gem… + lib/ruby/4.0.0/…). Consumers see the bare zip
# at programs/wasm32/ruby.zip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-}"
RUBY_DIR="${WASM_POSIX_DEP_RUBY_DIR:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-}"

fail() { echo "build-ruby-browser-bundle: $*" >&2; exit 2; }

require_real_directory() {
    local label="$1" path="$2"
    case "$path" in /*) ;; *) fail "$label must be an absolute resolver-owned directory: $path" ;; esac
    if [ ! -d "$path" ] || [ -L "$path" ]; then fail "$label must be a real directory: $path"; fi
}

[ "$TARGET_ARCH" = wasm32 ] || fail "browser bundle supports only wasm32"
require_real_directory WASM_POSIX_DEP_OUT_DIR "$OUT_DIR"
require_real_directory WASM_POSIX_DEP_WORK_DIR "$WORK_DIR"
require_real_directory WASM_POSIX_DEP_RUBY_DIR "$RUBY_DIR"

archive="$WORK_DIR/ruby.zip"
bash "$REPO_ROOT/images/vfs/scripts/build-ruby-zip.sh" "$RUBY_DIR" "$archive"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary ruby-browser-bundle "$archive" ruby.zip
