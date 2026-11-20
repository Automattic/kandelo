#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/omarchy-src"
STAGING="$WORK/omarchy-staging"

kandelo_package_stage_primary_source omarchy "$SRC" "$WORK"
for patch_file in "$HERE"/patches/*.patch; do
    echo "==> Applying $(basename "$patch_file")..."
    kandelo_package_git_apply_patch "$SRC" "$patch_file"
done

mkdir -p "$STAGING"
cd "$SRC"
while IFS= read -r pattern; do
    matches=($pattern)
    [ -e "${matches[0]}" ] || { echo "build-omarchy: no file matches $pattern" >&2; exit 1; }
    for path in "${matches[@]}"; do
        mkdir -p "$STAGING/$(dirname "$path")"
        cp -p "$path" "$STAGING/$path"
    done
done < "$HERE/allowlist"

for background in themes/*/backgrounds/*; do
    theme=${background#themes/}
    theme=${theme%%/*}
    mkdir -p "$STAGING/themes/$theme/backgrounds"
    ln -s "/usr/share/backgrounds/omarchy/$theme/${background##*/}" "$STAGING/$background"
done

for theme in "$STAGING"/themes/*/; do
    [ -d "${theme}backgrounds" ] || continue
    background=$(cd "$theme" && LC_ALL=C ls -d backgrounds/* | head -n 1)
    ln -s "$background" "${theme}preview.${background##*.}"
done

bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$STAGING" "$WORK/omarchy.zip"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary omarchy "$WORK/omarchy.zip" omarchy.zip
for background in "$SRC"/themes/*/backgrounds/*; do
    theme=${background%/backgrounds/*}
    install_local_runtime_file omarchy "$background" "backgrounds/${theme##*/}/${background##*/}"
done
