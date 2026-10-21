#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
PHP_DIR="${WASM_POSIX_DEP_PHP_DIR:?missing resolver-owned PHP dependency}"
[ "${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}" = wasm32 ] || {
    echo "build-composer: only wasm32 is supported" >&2
    exit 2
}
kandelo_package_require_existing_real_dir "PHP dependency" "$PHP_DIR" >/dev/null

SOURCE_DIR="$WORK_DIR/composer-source"
if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = source-only-v1 ] || \
   [ -n "${WASM_POSIX_DEP_SOURCE_DIR:-}" ]; then
    kandelo_package_stage_verified_source composer "$SOURCE_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
        "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK_DIR"
else
    # PHAR is an executable, signed PHP archive; extracting it would discard
    # its entry point and signature. Default resolution still verifies the
    # pinned source before packaging, just as SourceOnly's handoff does.
    mkdir -p "$SOURCE_DIR"
    kandelo_package_download_source_archive "$WASM_POSIX_DEP_SOURCE_URL" \
        "$SOURCE_DIR/source.phar"
    printf '%s  %s\n' "$WASM_POSIX_DEP_SOURCE_SHA256" "$SOURCE_DIR/source.phar" | shasum -a 256 -c -
fi

STAGING_DIR="$WORK_DIR/composer-staging"
mkdir -p "$STAGING_DIR/bin" "$STAGING_DIR/share/composer" "$STAGING_DIR/lib/composer"
cp "$HERE/composer" "$STAGING_DIR/bin/composer"
chmod 0755 "$STAGING_DIR/bin/composer"
cp "$SOURCE_DIR/source.phar" "$STAGING_DIR/share/composer/composer.phar"
chmod 0644 "$STAGING_DIR/share/composer/composer.phar"
for extension in phar curl zip; do
    artifact="$(kandelo_package_require_existing_regular_file \
        "PHP $extension extension" "$PHP_DIR/$extension.so")"
    cp "$artifact" "$STAGING_DIR/lib/composer/$extension.so"
    chmod 0644 "$STAGING_DIR/lib/composer/$extension.so"
done

bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" \
    "$STAGING_DIR" "$WORK_DIR/composer.zip"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary composer "$WORK_DIR/composer.zip" composer.zip
