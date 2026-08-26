/*
 * mtdev.h — libinput-scoped reproduction of the mtdev public ABI for
 * wasm32-posix-kernel. NOT a full mtdev port.
 *
 * The declarations and struct layouts below are byte-exact copies of
 * upstream mtdev's <mtdev.h> (Henrik Rydberg, MIT) so that an unmodified
 * libinput compiles against them and reads `mtdev->caps.slot.value` at
 * the correct offset. Only the five entry points libinput actually links
 * (mtdev_new_open, mtdev_put_event, mtdev_empty, mtdev_get_event,
 * mtdev_close_delete — see mtdev-plumbing.h) are backed by real objects;
 * the rest are declared for header parity but never referenced by
 * libinput and are not defined by the stub. See
 * docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5b).
 */
#ifndef _MTDEV_H
#define _MTDEV_H

#ifdef __cplusplus
extern "C" {
#endif

#include <linux/input.h>

#ifndef BTN_TOOL_QUADTAP
#define BTN_TOOL_QUADTAP	0x14f
#define ABS_MT_TOUCH_MAJOR	0x30
#define ABS_MT_TOUCH_MINOR	0x31
#define ABS_MT_WIDTH_MAJOR	0x32
#define ABS_MT_WIDTH_MINOR	0x33
#define ABS_MT_ORIENTATION	0x34
#define ABS_MT_POSITION_X	0x35
#define ABS_MT_POSITION_Y	0x36
#define ABS_MT_TOOL_TYPE	0x37
#define ABS_MT_BLOB_ID		0x38
#define ABS_MT_TRACKING_ID	0x39
#define SYN_MT_REPORT		2
#define MT_TOOL_FINGER		0
#define MT_TOOL_PEN		1
#endif
#ifndef ABS_MT_PRESSURE
#define ABS_MT_PRESSURE		0x3a
#endif
#ifndef ABS_MT_SLOT
#define ABS_MT_SLOT		0x2f
#endif
#ifndef ABS_MT_DISTANCE
#define ABS_MT_DISTANCE		0x3b
#endif
#ifndef EVIOCGMTSLOTS
#define EVIOCGMTSLOTS(len)	_IOC(_IOC_READ, 'E', 0x0a, len)
#endif

#define MT_ID_NULL	(-1)
#define MT_ID_MIN	0
#define MT_ID_MAX	65535

struct mtdev *mtdev_new_open(int fd);
int mtdev_open(struct mtdev *dev, int fd);
int mtdev_has_mt_event(const struct mtdev *dev, int code);
int mtdev_get_abs_minimum(const struct mtdev *dev, int code);
int mtdev_get_abs_maximum(const struct mtdev *dev, int code);
int mtdev_get_abs_fuzz(const struct mtdev *dev, int code);
int mtdev_get_abs_resolution(const struct mtdev *dev, int code);
int mtdev_idle(struct mtdev *dev, int fd, int ms);
int mtdev_get(struct mtdev *dev, int fd, struct input_event* ev, int ev_max);
void mtdev_close(struct mtdev *dev);
void mtdev_close_delete(struct mtdev *dev);

#ifndef MTDEV_NO_LEGACY_API

#define MT_ABS_SIZE 11
#ifndef MT_SLOT_ABS_EVENTS
#define MT_SLOT_ABS_EVENTS {	\
	ABS_MT_TOUCH_MAJOR,	\
	ABS_MT_TOUCH_MINOR,	\
	ABS_MT_WIDTH_MAJOR,	\
	ABS_MT_WIDTH_MINOR,	\
	ABS_MT_ORIENTATION,	\
	ABS_MT_POSITION_X,	\
	ABS_MT_POSITION_Y,	\
	ABS_MT_TOOL_TYPE,	\
	ABS_MT_BLOB_ID,		\
	ABS_MT_TRACKING_ID,	\
	ABS_MT_PRESSURE,	\
}
#endif

struct mtdev_caps {
	int has_mtdata;
	int has_slot;
	int has_abs[MT_ABS_SIZE];
	struct input_absinfo slot;
	struct input_absinfo abs[MT_ABS_SIZE];
};

struct mtdev {
	struct mtdev_caps caps;
	struct mtdev_state *state;
};

#endif

#ifdef __cplusplus
}
#endif

#endif
