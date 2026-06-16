/*
 * Minimal <xf86drm.h> for wasm-posix-kernel.
 *
 * Declares the libdrm user-space entry points implemented by
 * libc/glue/libdrm_stub.c. The shape mirrors upstream libdrm
 * (https://gitlab.freedesktop.org/mesa/drm) so user programs that
 * `#include <xf86drm.h>` and `-ldrm` against this sysroot compile
 * unchanged from their Linux counterpart.
 *
 * Phase C of the DRI buffer-sharing plan
 * (docs/plans/2026-05-25-dri-buffer-sharing-plan.md §C). The shim
 * surface is intentionally small — Phase A wired the kernel ioctl
 * surface, so we only need wrappers, not the full libdrm.
 */

#ifndef _XF86DRM_H
#define _XF86DRM_H 1

#include <stdint.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Upstream libdrm uses `int` (signed) here, even though the wire
 * format's `struct drm_version` uses `__kernel_size_t` (unsigned).
 * Match upstream so source code is portable byte-for-byte. */
typedef struct _drmVersion {
    int   version_major;
    int   version_minor;
    int   version_patchlevel;
    int   name_len;
    char *name;
    int   date_len;
    char *date;
    int   desc_len;
    char *desc;
} drmVersion, *drmVersionPtr;

/* EINTR-retrying wrapper around ioctl(2). Returns whatever the
 * underlying ioctl(3) returns; never returns -1/EINTR. */
int drmIoctl(int fd, unsigned long request, void *arg);

/* DRM_IOCTL_VERSION wrapper. Returns a heap-allocated drmVersion;
 * caller must drmFreeVersion(). Returns NULL on ioctl/alloc error
 * (errno preserved). The version triple comes from the kernel; the
 * name/desc/date strings are synthesised client-side (the kernel
 * returns zero-length strings — see Q2 in
 * docs/plans/2026-05-20-dri-session-handoff-19.md). */
drmVersionPtr drmGetVersion(int fd);

/* Frees a drmVersionPtr previously returned by drmGetVersion(). */
void drmFreeVersion(drmVersionPtr v);

/* DRM_IOCTL_GEM_CLOSE wrapper. Closes a GEM buffer object handle
 * (per-fd, allocated by DRM_IOCTL_MODE_CREATE_DUMB). Returns 0 on
 * success, -1/errno on failure. */
int drmCloseBufferHandle(int fd, uint32_t handle);

/* DRM_IOCTL_SET_MASTER / DRM_IOCTL_DROP_MASTER wrappers. */
int drmSetMaster(int fd);
int drmDropMaster(int fd);

#ifdef __cplusplus
}
#endif

#endif /* _XF86DRM_H */
