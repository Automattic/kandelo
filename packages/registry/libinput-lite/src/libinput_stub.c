/*
 * libinput-lite — no-op stub. See ../include/libinput.h for the
 * rationale: SDL2 2.30 uses its own direct evdev backend (plan 5)
 * on this kernel, and any consumer that prefers libinput first
 * gets pushed into its fallback path by these NULL returns.
 */

#include <libinput.h>
#include <stddef.h>  /* NULL */

/* Opaque type so callers can hold a pointer; we never allocate one. */
struct libinput { int unused; };

struct libinput *libinput_udev_create_context(
    const struct libinput_interface *interface,
    void *user_data,
    struct udev *udev)
{
    (void) interface;
    (void) user_data;
    (void) udev;
    return NULL;
}

struct libinput *libinput_path_create_context(
    const struct libinput_interface *interface,
    void *user_data)
{
    (void) interface;
    (void) user_data;
    return NULL;
}

void libinput_unref(struct libinput *li) { (void) li; }

int libinput_dispatch(struct libinput *li) { (void) li; return 0; }

struct libinput_event *libinput_get_event(struct libinput *li)
{
    (void) li;
    return NULL;
}
