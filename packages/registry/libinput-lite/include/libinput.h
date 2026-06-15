/*
 * libinput-lite — minimal public header for the libinput API shape
 * SDL2 2.30's configure step probes for. The wasm32-posix-kernel
 * has no libudev backend; SDL2's evdev path handles input directly
 * (plan 5), and any consumer that prefers libinput first then falls
 * back is forced into the fallback by every entry point returning
 * NULL.
 *
 * Surface: only the symbols SDL2 actually references at compile
 * and link time. The real libinput.h is much larger; consumers
 * that need extra entry points get link-time undefined-symbol
 * errors, on purpose — that signals the host is not the right
 * platform for that input backend.
 */

#ifndef LIBINPUT_H
#define LIBINPUT_H

#ifdef __cplusplus
extern "C" {
#endif

struct libinput;
struct libinput_event;
struct libinput_interface;
struct udev;

/* Always returns NULL on this host — there is no udev to enumerate
 * against. Consumers degrade to whatever fallback they have. */
struct libinput *libinput_udev_create_context(
    const struct libinput_interface *interface,
    void *user_data,
    struct udev *udev);

/* Always returns NULL — the path-based context needs evdev opens
 * the stub cannot provide. */
struct libinput *libinput_path_create_context(
    const struct libinput_interface *interface,
    void *user_data);

/* No-op for the stub since create returns NULL; kept for API
 * completeness so callers that release a (NULL) context link
 * cleanly. */
void libinput_unref(struct libinput *li);

/* No-op; returns 0 (success) because the empty event ring is the
 * stub's permanent state. */
int libinput_dispatch(struct libinput *li);

/* Always returns NULL — the stub never enqueues events. */
struct libinput_event *libinput_get_event(struct libinput *li);

#ifdef __cplusplus
}
#endif

#endif /* LIBINPUT_H */
