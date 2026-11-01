#ifndef WPK_WAYLAND_NATIVE_H
#define WPK_WAYLAND_NATIVE_H
#include <stdint.h>
#ifndef WPK_WAYLAND_OPTIONAL
#define WPK_WAYLAND_OPTIONAL
#endif
/* Private same-module capabilities. Never exported on the guest/kernel wire. */
WPK_WAYLAND_OPTIONAL int _wpk_wl_display_metadata(const void *, uint64_t *);
WPK_WAYLAND_OPTIONAL void *_wpk_wl_display_acquire(const void *, uint64_t);
WPK_WAYLAND_OPTIONAL int _wpk_wl_display_alive(void *);
WPK_WAYLAND_OPTIONAL void _wpk_wl_display_release(void *);
WPK_WAYLAND_OPTIONAL void *_wpk_wl_surface_acquire(const void *, const void **, uint64_t *);
WPK_WAYLAND_OPTIONAL int _wpk_wl_surface_alive(void *);
WPK_WAYLAND_OPTIONAL int _wpk_wl_surface_present(void *, void *, int, int);
WPK_WAYLAND_OPTIONAL void _wpk_wl_surface_release(void *);
struct wpk_wlegl_frame {int fd; uint32_t handle, width, height;};
WPK_WAYLAND_OPTIONAL int _wpk_wlegl_acquire(const void *, const void *, uint64_t, void **, struct wpk_wlegl_frame *);
WPK_WAYLAND_OPTIONAL int _wpk_wlegl_prepare(void *, struct wpk_wlegl_frame *);
/* Reserves a distinct normalized front; caller must finish on every path. */
WPK_WAYLAND_OPTIONAL int _wpk_wlegl_prepare_present(void *, struct wpk_wlegl_frame *);
WPK_WAYLAND_OPTIONAL int _wpk_wlegl_finish(void *, int);
WPK_WAYLAND_OPTIONAL void _wpk_wlegl_release(void *);
#endif
