#!/usr/bin/env bash
# Build libdrm (libdrm.a) — KMS-side subset only — for Kandelo.
#
# Wraps the kernel's DRM_IOCTL_MODE_* surface in the standard libdrm
# API (drmModeGetResources, drmModeAddFB2, drmModePageFlip,
# drmHandleEvent) that SDL2's KMSDRM video backend
# (`src/video/kmsdrm/SDL_kmsdrmvideo.c`) calls.
#
# We bypass upstream's meson and skip the per-vendor subdirs
# (libdrm_amdgpu, libdrm_radeon, libdrm_intel, libdrm_nouveau, …) —
# none of those run on the wasm32 kernel and they pull in
# vendor-specific ioctl tables we don't ship.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR/libdrm-work" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"

LIBDRM_VERSION="${WASM_POSIX_DEP_VERSION:-2.4.120}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://dri.freedesktop.org/libdrm/libdrm-${LIBDRM_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-3bf55363f76c7250946441ab51d3a6cc0ae518055c0ff017324ab76cdefb327a}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:?WASM_POSIX_DEP_OUT_DIR must name the resolver staging directory}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: libdrm currently supports only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
CC=wasm32posix-cc
AR=wasm32posix-ar
for tool in "$CC" "$AR" curl tar shasum python3; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: required build tool not found: $tool" >&2
        exit 1
    }
done

SRC_DIR="$WORK_DIR/source"
BUILD_DIR="$WORK_DIR/build"
REPRO_FLAGS="-ffile-prefix-map=$WORK_DIR=/usr/src/libdrm -fdebug-prefix-map=$WORK_DIR=/usr/src/libdrm -fmacro-prefix-map=$WORK_DIR=/usr/src/libdrm"

# The resolver acquires and verifies the archive before this script runs, so
# stage its tree rather than fetch the tarball a second time.
echo "==> Staging verified libdrm $LIBDRM_VERSION source..."
rm -rf "$SRC_DIR"
kandelo_package_stage_verified_source libdrm "$SRC_DIR" \
    "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib" \
         "$INSTALL_DIR/include/drm" "$INSTALL_DIR/include/libdrm"

# Stage the KMS-side sources into a flat build dir — only the four
# files SDL2's KMSDRM backend pulls in transitively, plus the UAPI
# headers they include as `<drm.h>` / `<drm_fourcc.h>`.
echo "==> Staging the libdrm KMS subset..."
for f in xf86drm.c xf86drmMode.c xf86drmHash.c xf86drmRandom.c \
         xf86drm.h xf86drmMode.h xf86drmHash.h xf86drmRandom.h \
         libdrm_macros.h util_math.h \
         include/drm/drm.h include/drm/drm_mode.h \
         include/drm/drm_fourcc.h; do
    cp "$SRC_DIR/$f" "$BUILD_DIR/"
done

python3 "$SRC_DIR/gen_table_fourcc.py" \
    "$BUILD_DIR/drm_fourcc.h" \
    "$BUILD_DIR/generated_static_table_fourcc.h"

# The DRM UAPI headers open with `#include <linux/types.h>` for the
# kernel-style __u8/__u32/__s64 typedefs and `#include <asm/ioctl.h>`
# for the _IOC()/_IO*() macros. The Linux kernel ships both; musl does
# not, since they are UAPI and not libc surface. Drop forwarding shims
# so the kernel-side scalar names map onto C99 fixed-width types and
# <asm/ioctl.h> resolves to the same macros bits/ioctl.h already
# defines.
mkdir -p "$BUILD_DIR/linux" "$BUILD_DIR/asm"
cat > "$BUILD_DIR/asm/ioctl.h" <<'EOF'
#ifndef _ASM_IOCTL_H_LIBDRM_SHIM
#define _ASM_IOCTL_H_LIBDRM_SHIM
#include <sys/ioctl.h>
#endif
EOF
cat > "$BUILD_DIR/linux/types.h" <<'EOF'
#ifndef _LINUX_TYPES_H_LIBDRM_SHIM
#define _LINUX_TYPES_H_LIBDRM_SHIM
#include <stdint.h>
#include <sys/types.h>
typedef uint8_t  __u8;
typedef int8_t   __s8;
typedef uint16_t __u16;
typedef int16_t  __s16;
typedef uint32_t __u32;
typedef int32_t  __s32;
typedef uint64_t __u64;
typedef int64_t  __s64;
typedef uint16_t __le16;
typedef uint16_t __be16;
typedef uint32_t __le32;
typedef uint32_t __be32;
typedef uint64_t __le64;
typedef uint64_t __be64;
typedef size_t   __kernel_size_t;
typedef ssize_t  __kernel_ssize_t;
typedef long     __kernel_long_t;
typedef unsigned long __kernel_ulong_t;
#endif
EOF

# Feature-test macros that:
#   * select libdrm's Linux ioctl-macro flavour — xf86drm.h gates
#     DRM_IOC_READ / DRM_IOC_WRITE on __linux__, and the BSD branch
#     references IOC_OUT / IOC_IN from <sys/ioccom.h>, which musl does
#     not ship;
#   * point libdrm at musl's <sys/sysmacros.h> for major()/minor() —
#     xf86drm.c only pulls those macros in when one of
#     MAJOR_IN_MKDEV / MAJOR_IN_SYSMACROS is defined, and musl has the
#     sysmacros form;
#   * disable the host-OS detection paths libdrm invokes only from
#     error and init code (sysctl-based device discovery via
#     HAVE_SYS_SYSCTL_H). The wasm sysroot has no PCI bus, no
#     sysctl(), and no /dev/pci, so those probes are dead code here.
cat > "$BUILD_DIR/xf86drm_compat.h" <<'EOF'
/* libdrm-KMS feature-test compat header — see build-libdrm.sh. */

#ifndef __linux__
#define __linux__ 1
#endif

#define MAJOR_IN_SYSMACROS 1
#define HAVE_SYS_SYSCTL_H 0
#define HAVE_VISIBILITY 1
EOF

echo "==> Compiling the libdrm KMS subset..."
(
    cd "$BUILD_DIR"
    CFLAGS=(
        -O2 -std=gnu11
        -include xf86drm_compat.h
        -I.
        $REPRO_FLAGS
    )
    for src in xf86drm.c xf86drmMode.c xf86drmHash.c xf86drmRandom.c; do
        "$CC" -c "${CFLAGS[@]}" "$src" -o "${src%.c}.o"
    done
    "$AR" rcs "$INSTALL_DIR/lib/libdrm.a" \
        xf86drm.o xf86drmMode.o xf86drmHash.o xf86drmRandom.o
)

# UAPI headers under include/drm/ (consumers: #include <drm.h>,
# <drm_mode.h>, <drm_fourcc.h>). Public libdrm headers under
# include/libdrm/ (consumers: #include <xf86drm.h>, <xf86drmMode.h>) —
# the split matches upstream's pkg-config --cflags.
echo "==> Installing headers..."
cp "$SRC_DIR/include/drm/drm.h"        "$INSTALL_DIR/include/drm/"
cp "$SRC_DIR/include/drm/drm_mode.h"   "$INSTALL_DIR/include/drm/"
cp "$SRC_DIR/include/drm/drm_fourcc.h" "$INSTALL_DIR/include/drm/"
cp "$SRC_DIR/xf86drm.h"                "$INSTALL_DIR/include/libdrm/"
cp "$SRC_DIR/xf86drmMode.h"            "$INSTALL_DIR/include/libdrm/"

# A consumer that defines __linux__ (Qt clients must) sends drm.h down
# its Linux branch, which includes <linux/types.h> and <asm/ioctl.h> —
# UAPI headers musl does not ship. Install the same forwarding shims
# this script compiles against, so the installed headers are
# self-contained; the .pc's -I${includedir} puts them on the path.
mkdir -p "$INSTALL_DIR/include/linux" "$INSTALL_DIR/include/asm"
cp "$BUILD_DIR/linux/types.h" "$INSTALL_DIR/include/linux/"
cp "$BUILD_DIR/asm/ioctl.h"   "$INSTALL_DIR/include/asm/"

mkdir -p "$INSTALL_DIR/lib/pkgconfig"
cat > "$INSTALL_DIR/lib/pkgconfig/libdrm.pc" <<PCEOF
prefix=\${pcfiledir}/../..
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: libdrm
Description: Userspace interface to kernel DRM services
Version: $LIBDRM_VERSION
Libs: -L\${libdir} -ldrm
Cflags: -I\${includedir} -I\${includedir}/libdrm -I\${includedir}/drm
PCEOF

test -f "$INSTALL_DIR/lib/libdrm.a"
test -f "$INSTALL_DIR/include/libdrm/xf86drmMode.h"
test -f "$INSTALL_DIR/include/drm/drm_fourcc.h"
test -f "$INSTALL_DIR/lib/pkgconfig/libdrm.pc"
echo "==> libdrm $LIBDRM_VERSION KMS-subset package complete"
