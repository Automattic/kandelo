#!/usr/bin/env bash
#
# Build libdrm (libdrm.a) — KMS-side subset only — for
# wasm32-posix-kernel. Wraps plan 4's DRM_IOCTL_MODE_* surface in the
# standard libdrm API (drmModeGetResources, drmModeAddFB2,
# drmModePageFlip, drmHandleEvent) that SDL2's KMSDRM video backend
# (`src/video/kmsdrm/SDL_kmsdrmvideo.c`) calls.
#
# We bypass upstream's meson and skip the per-vendor subdirs
# (libdrm_amdgpu, libdrm_radeon, libdrm_intel, libdrm_nouveau, …) —
# none of those run on the wasm32 kernel and they pull in
# vendor-specific ioctl tables we don't ship.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libdrm`, env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR        # where to install lib/ + include/
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/libdrm-src"

LIBDRM_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBDRM_VERSION:-2.4.120}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libdrm-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://dri.freedesktop.org/libdrm/libdrm-${LIBDRM_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found — needed to generate libdrm's static fourcc table." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libdrm $LIBDRM_VERSION..."
    TARBALL="/tmp/libdrm-${LIBDRM_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

# Fresh build + install dir each run — cache key varies per build and
# stale objects would shadow header changes.
BUILD_DIR="$SCRIPT_DIR/libdrm-build"
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib" \
         "$INSTALL_DIR/include/drm" "$INSTALL_DIR/include/libdrm"

# --- Stage the KMS-side source files into a flat build dir ---
# Only the four files SDL2's KMSDRM backend pulls in transitively.
for f in xf86drm.c xf86drmMode.c xf86drmHash.c xf86drmRandom.c \
         xf86drm.h xf86drmMode.h xf86drmHash.h xf86drmRandom.h \
         libdrm_macros.h libdrm_lists.h util_math.h libsync.h; do
    cp "$SRC_DIR/$f" "$BUILD_DIR/"
done

# --- Stage UAPI headers (drm.h, drm_mode.h, drm_fourcc.h, …) ---
# libdrm's source includes `<drm.h>` / `<drm_fourcc.h>` — they live
# under include/drm/ in the tarball and our sysroot installs them at
# include/drm/.
cp "$SRC_DIR/include/drm/drm.h" "$BUILD_DIR/"
cp "$SRC_DIR/include/drm/drm_mode.h" "$BUILD_DIR/"
cp "$SRC_DIR/include/drm/drm_fourcc.h" "$BUILD_DIR/"
cp "$SRC_DIR/include/drm/drm_sarea.h" "$BUILD_DIR/"

# --- Generate the static fourcc table xf86drm.c includes ---
python3 "$SRC_DIR/gen_table_fourcc.py" \
    "$BUILD_DIR/drm_fourcc.h" \
    "$BUILD_DIR/generated_static_table_fourcc.h"

# --- Linux UAPI shims ---
# DRM UAPI headers (drm.h, drm_mode.h, drm_fourcc.h) start with
# `#include <linux/types.h>` for kernel-style __u8/__u32/__s64
# typedefs and `#include <asm/ioctl.h>` for the _IOC()/_IO*() macros.
# The Linux kernel ships both; musl doesn't, since they are UAPI not
# libc surface. Drop forwarding shims so the kernel-side scalar names
# map onto C99 fixed-width types, and <asm/ioctl.h> resolves to the
# same _IOC()/_IO/IOW/IOR/IOWR our bits/ioctl.h already defines.
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

# --- Feature-test compat header ---
# Feature-test macros that:
#   * select libdrm's Linux ioctl-macro flavour (xf86drm.h gates
#     DRM_IOC_READ / DRM_IOC_WRITE on __linux__; the BSD branch
#     references IOC_OUT / IOC_IN from <sys/ioccom.h>, which musl
#     doesn't ship);
#   * point libdrm at musl's <sys/sysmacros.h> for major()/minor()
#     (xf86drm.c only pulls those macros in if one of MAJOR_IN_MKDEV
#     / MAJOR_IN_SYSMACROS is defined; musl has the sysmacros form);
#   * disable the host-OS detection paths libdrm invokes only from
#     error/init code (sysctl-based device discovery via
#     HAVE_SYS_SYSCTL_H, the symbol-visibility attribute toggle).
#     The wasm sysroot has no PCI bus, no sysctl(), and no /dev/pci,
#     so the corresponding probes are dead code on this target.
cat > "$BUILD_DIR/xf86drm_compat.h" <<'EOF'
/* libdrm-KMS feature-test compat header — see build-libdrm.sh. */

#ifndef __linux__
#define __linux__ 1
#endif

#define MAJOR_IN_SYSMACROS 1
#define HAVE_SYS_SYSCTL_H 0
#define HAVE_VISIBILITY 1
EOF

# --- Compile the four KMS-side .c files ---
cd "$BUILD_DIR"

CFLAGS=(
    -O2 -fPIC -std=gnu11
    -DHAVE_LIBDRM_ATOMIC_PRIMITIVES=0
    -DHAVE_VISIBILITY=1
    -include xf86drm_compat.h
    -I.
)

echo "==> Compiling libdrm-KMS subset..."
for src in xf86drm.c xf86drmMode.c xf86drmHash.c xf86drmRandom.c; do
    wasm32posix-cc -c "${CFLAGS[@]}" "$src" -o "${src%.c}.o"
done

echo "==> Archiving libdrm.a..."
llvm-ar rcs "$INSTALL_DIR/lib/libdrm.a" \
    xf86drm.o xf86drmMode.o xf86drmHash.o xf86drmRandom.o

# --- Install headers ---
echo "==> Installing headers..."
# UAPI headers under include/drm/ (consumers: #include <drm.h>,
# <drm_mode.h>, <drm_fourcc.h>).
cp "$SRC_DIR/include/drm/drm.h"        "$INSTALL_DIR/include/drm/"
cp "$SRC_DIR/include/drm/drm_mode.h"   "$INSTALL_DIR/include/drm/"
cp "$SRC_DIR/include/drm/drm_fourcc.h" "$INSTALL_DIR/include/drm/"
cp "$SRC_DIR/include/drm/drm_sarea.h"  "$INSTALL_DIR/include/drm/"

# Public libdrm headers under include/libdrm/ (consumers:
# #include <xf86drm.h>, <xf86drmMode.h>).
cp "$SRC_DIR/xf86drm.h"     "$INSTALL_DIR/include/libdrm/"
cp "$SRC_DIR/xf86drmMode.h" "$INSTALL_DIR/include/libdrm/"

echo "==> libdrm $LIBDRM_VERSION installed at $INSTALL_DIR"
echo "    lib/libdrm.a ($(wc -c < "$INSTALL_DIR/lib/libdrm.a") bytes)"
