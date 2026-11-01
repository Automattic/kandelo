#ifndef WPK_GBM_WINDOW_H
#define WPK_GBM_WINDOW_H
#include <stdint.h>
/* Private in-process ownership bridge. No guest/kernel wire layout changes. */
/* Return a caller-owned CLOEXEC alias only while this exact public device is
 * live. Identity validation and duplication share the withdrawal lock. */
int _wpk_gbm_device_acquire_fd(const void *native, uint64_t identity);
struct wpk_gbm_frame {
    int fd;
    uint32_t handle, width, height, format, pitch;
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
#endif
