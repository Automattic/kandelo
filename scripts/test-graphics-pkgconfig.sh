#!/usr/bin/env bash
# Prove copied sysroots resolve graphics flags from their current location.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

original_sysroot="$TMP_ROOT/original/sysroot"
relocated_sysroot="$TMP_ROOT/relocated/sysroot"
original_pc="$original_sysroot/lib/pkgconfig"
mkdir -p "$original_pc" "$(dirname "$relocated_sysroot")"

bash "$REPO_ROOT/scripts/write-graphics-pkgconfig.sh" dri "$original_pc"
bash "$REPO_ROOT/scripts/write-graphics-pkgconfig.sh" gles "$original_pc"

for pc_file in libdrm.pc gbm.pc egl.pc glesv2.pc; do
    grep -Fx 'prefix=${pcfiledir}/../..' "$original_pc/$pc_file" >/dev/null || {
        echo "test-graphics-pkgconfig.sh: $pc_file does not derive its prefix from pcfiledir" >&2
        exit 1
    }
done

cp -R "$original_sysroot" "$relocated_sysroot"
relocated_prefix="$relocated_sysroot/lib/pkgconfig/../.."
for package in libdrm gbm egl glesv2; do
    flags="$(env -u PKG_CONFIG_SYSROOT_DIR \
        PKG_CONFIG_PATH= \
        PKG_CONFIG_LIBDIR="$relocated_sysroot/lib/pkgconfig" \
        pkg-config --cflags --libs "$package")"
    case "$flags" in
        *"$relocated_prefix/include"*"$relocated_prefix/lib"* | \
        *"$relocated_prefix/lib"*"$relocated_prefix/include"*) ;;
        *)
            echo "test-graphics-pkgconfig.sh: $package did not resolve inside the copied sysroot: $flags" >&2
            exit 1
            ;;
    esac
    if [[ "$flags" == *"$original_sysroot"* ]]; then
        echo "test-graphics-pkgconfig.sh: $package retained its original sysroot: $flags" >&2
        exit 1
    fi
done

echo "test-graphics-pkgconfig.sh: ok"
