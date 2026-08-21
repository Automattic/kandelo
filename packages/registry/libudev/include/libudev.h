/*
 * libudev.h — libinput-scoped shim of the libudev API for
 * wasm32-posix-kernel. NOT a full libudev.
 *
 * Declares exactly the udev entry points libinput's PATH backend links
 * (the udev/seat enumeration + monitor API is unused — udev-seat.c is
 * dropped from the port). The signatures match upstream <libudev.h> so
 * an unmodified libinput compiles against them. `struct udev` and
 * `struct udev_device` are opaque; the shim owns their storage. See
 * src/libudev_shim.c and
 * docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5b).
 */
#ifndef _LIBUDEV_SHIM_H
#define _LIBUDEV_SHIM_H

#include <sys/types.h> /* dev_t */

#ifdef __cplusplus
extern "C" {
#endif

struct udev;
struct udev_device;

/* --- context --- */
struct udev *udev_new(void);
struct udev *udev_unref(struct udev *udev);

/* --- device lifetime --- */
struct udev_device *udev_device_ref(struct udev_device *udev_device);
struct udev_device *udev_device_unref(struct udev_device *udev_device);
struct udev_device *udev_device_new_from_devnum(struct udev *udev, char type,
						dev_t devnum);
struct udev_device *udev_device_new_from_syspath(struct udev *udev,
						 const char *syspath);

/* --- device queries --- */
struct udev *udev_device_get_udev(struct udev_device *udev_device);
struct udev_device *udev_device_get_parent(struct udev_device *udev_device);
struct udev_device *
udev_device_get_parent_with_subsystem_devtype(struct udev_device *udev_device,
					      const char *subsystem,
					      const char *devtype);
const char *udev_device_get_devnode(struct udev_device *udev_device);
const char *udev_device_get_syspath(struct udev_device *udev_device);
const char *udev_device_get_sysname(struct udev_device *udev_device);
int udev_device_get_is_initialized(struct udev_device *udev_device);
const char *udev_device_get_property_value(struct udev_device *udev_device,
					   const char *key);

#ifdef __cplusplus
}
#endif

#endif
