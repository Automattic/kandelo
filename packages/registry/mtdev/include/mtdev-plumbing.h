/*
 * mtdev-plumbing.h — libinput-scoped reproduction of mtdev's plumbing
 * ABI for wasm32-posix-kernel. NOT a full mtdev port.
 *
 * libinput's evdev backend includes ONLY this header (which pulls in
 * <mtdev.h>). Of the prototypes below, libinput links exactly five —
 * mtdev_new_open, mtdev_put_event, mtdev_empty, mtdev_get_event,
 * mtdev_close_delete — and only ever calls them for legacy multitouch
 * protocol-A devices (`evdev_need_mtdev()`: has ABS_MT_POSITION_X/Y but
 * NOT ABS_MT_SLOT). The kernel's virtual pointer advertises plain
 * ABS_X/ABS_Y (not the ABS_MT_* multitouch axes), so `evdev_need_mtdev()`
 * is always false, `device->mtdev` stays NULL, and none of the five are
 * ever reached at runtime. The stub (src/mtdev_stub.c) therefore only
 * needs to satisfy the link; each entry point aborts if actually called,
 * because a call means that invariant broke and must be diagnosed. See
 * docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5b).
 */
#ifndef _MTDEV_PLUMBING_H
#define _MTDEV_PLUMBING_H

#ifdef __cplusplus
extern "C" {
#endif

#include <mtdev.h>

struct mtdev *mtdev_new(void);
int mtdev_init(struct mtdev *dev);
void mtdev_set_mt_event(struct mtdev *dev, int code, int value);
void mtdev_set_abs_minimum(struct mtdev *dev, int code, int value);
void mtdev_set_abs_maximum(struct mtdev *dev, int code, int value);
void mtdev_set_abs_fuzz(struct mtdev *dev, int code, int value);
void mtdev_set_abs_resolution(struct mtdev *dev, int code, int value);
int mtdev_configure(struct mtdev *dev, int fd);
int mtdev_fetch_event(struct mtdev *dev, int fd, struct input_event *ev);
void mtdev_put_event(struct mtdev *dev, const struct input_event *ev);
int mtdev_empty(struct mtdev *dev);
void mtdev_get_event(struct mtdev *dev, struct input_event* ev);
void mtdev_delete(struct mtdev *dev);

#ifdef __cplusplus
}
#endif

#endif
