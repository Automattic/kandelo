#ifndef WPK_GBM_WINDOW_H
#define WPK_GBM_WINDOW_H
#include <stdint.h>
/* Private in-process ownership bridge. No guest/kernel wire layout changes. */
/* Return a caller-owned CLOEXEC alias only while this exact public device is
 * live. Identity validation and duplication share the withdrawal lock. */
struct wpk_drm_owner;
struct gbm_device *_wpk_gbm_device_from_owner(struct wpk_drm_owner *owner);
int _wpk_gbm_device_acquire_owner(const void *native,uint64_t identity,struct wpk_drm_owner **owner);
int _wpk_gbm_device_acquire_fd(const void *native, uint64_t identity);
struct wpk_gbm_frame {
    int fd;
    uint32_t handle, width, height, format, pitch;
    struct wpk_drm_owner *owner,*bo_owner;
};
/* GBM_BO_IMPORT_EGL_IMAGE: the planes of a live EGLImage owned by the EGL
 * display initialized on GBM device `device` (with its `identity`). Each of
 * the first `num_planes` `fds` is a caller-owned PRIME descriptor naming
 * that plane's storage (the rest are -1). Returns 0, or -1 with errno
 * EINVAL when no such image exists or it has no DRM format. */
struct wpk_gbm_image {
    uint32_t width, height, format, num_planes;
    int fds[4];
    uint32_t strides[4], offsets[4];
};
int _wpk_egl_image_export_gbm(const void *image, const void *device, uint64_t identity,
                              struct wpk_gbm_image *planes);
int _wpk_gbm_window_acquire(const void *window, void **lease, struct wpk_gbm_frame *frame);
int _wpk_gbm_window_prepare(void *lease, struct wpk_gbm_frame *frame);
void _wpk_gbm_window_finish(void *lease, int accepted);
void _wpk_gbm_window_release(void *lease);
/* Keep the capsule globally reachable with one exclusive actor per process
 * until both fields clear. A child may adopt a vanished actor, but a continuing forkcaller stack
 * keeps its live claim.
 * This is cold retirement state, not an extra per-frame resource. */
struct wpk_gbm_window_retirement { void *live, *retired; };
void _wpk_gbm_window_release_pending(struct wpk_gbm_window_retirement *);
void _wpk_gbm_surface_destroy_pending(struct wpk_gbm_window_retirement *);
void _wpk_gbm_device_destroy_pending(struct gbm_device **);
/* A dedicated, caller-rooted front hold, separate from any cached BO pointer.
 * Non-NULL bo owns exactly one in_use slot. The caller provides one exclusive
 * actor and publishes/transfers this capsule under the common fork guard.
 * 0 means EMPTY or exact retirement transferred to the internal surface queue;
 * -1 retains invalid custody and diagnoses it. No acquisition API is implied. */
struct gbm_surface;
struct gbm_bo;
struct wpk_gbm_front_hold { struct gbm_surface *surface; struct gbm_bo *bo; };
int _wpk_gbm_surface_release_buffer_pending(struct wpk_gbm_front_hold *);
#endif
