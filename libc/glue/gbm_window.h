#ifndef WPK_GBM_WINDOW_H
#define WPK_GBM_WINDOW_H
#include <stdint.h>
/* Private in-process ownership bridge. No guest/kernel wire layout changes. */
/* Return a caller-owned CLOEXEC alias only while this exact public device is
 * live. Identity validation and duplication share the withdrawal lock. */
int _wpk_gbm_device_acquire_fd(const void *native, uint64_t identity);
struct wpk_gbm_frame {
    int fd;
    uint32_t handle, width, height;
};
int _wpk_gbm_window_acquire(const void *window, void **lease, struct wpk_gbm_frame *frame);
int _wpk_gbm_window_prepare(void *lease, struct wpk_gbm_frame *frame);
void _wpk_gbm_window_finish(void *lease, int accepted);
void _wpk_gbm_window_release(void *lease);
#endif
