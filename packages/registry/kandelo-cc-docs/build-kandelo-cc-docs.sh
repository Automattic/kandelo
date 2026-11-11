#!/usr/bin/env bash
# The manual page for kandelo-cc, the Kandelo SDK driver, as
# kandelo-cc-docs.zip, a lazy archive mounted at /usr/. kandelo-cc is
# every SDK tool, selected by the name it runs as, so cc, c89, c99, c++
# and the wasm32posix-* names link to its page, which describes each.
# kandelo_man_pages_own_commands lays out what `kandelo-cc --help` prints
# inside Kandelo.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
OWNER="${WASM_POSIX_DEP_KANDELO_CC_DIR:?kandelo-cc dependency dir required}"

aliases=()
for name in cc c89 c99 c++ wasm32posix-cc wasm32posix-c++ wasm32posix-ar \
    wasm32posix-ranlib wasm32posix-nm wasm32posix-strip \
    wasm32posix-configure wasm32posix-pkg-config; do
    aliases+=("$name.1=>kandelo-cc.1")
done
kandelo_man_pages_own_commands kandelo-cc-docs kandelo-cc 0.1.0 \
    kandelo-cc.1="$OWNER/kandelo-cc.wasm" "${aliases[@]}"
