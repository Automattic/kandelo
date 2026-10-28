#ifndef WPK_GBM_WINDOW_H
#define WPK_GBM_WINDOW_H
#include <stdint.h>
/* Private in-process ownership bridge. No guest/kernel wire layout changes. */
struct wpk_gbm_frame {
    int fd;
    uint32_t handle, width, height;
};
int _wpk_gbm_window_acquire(const void *window, void **lease, struct wpk_gbm_frame *frame);
int _wpk_gbm_window_prepare(void *lease, struct wpk_gbm_frame *frame);
void _wpk_gbm_window_finish(void *lease, int accepted);
void _wpk_gbm_window_release(void *lease);
#endif
