/*
 * libinput-lite stub smoke test. Validates that the no-op libinput
 * stub (packages/registry/libinput-lite/) links, that every entry
 * point is reachable through the public header, and that
 * libinput_udev_create_context() returns NULL — the signal real
 * consumers (SDL2 2.30 in particular) use to fall back to the
 * direct evdev backend.
 *
 * Used by host/test/libinput-stub.test.ts.
 */
#include <libinput.h>
#include <stddef.h>
#include <stdio.h>

int main(void)
{
    struct libinput *udev_ctx = libinput_udev_create_context(NULL, NULL, NULL);
    if (udev_ctx != NULL) {
        fprintf(stderr, "FAIL: libinput_udev_create_context returned %p (expected NULL)\n",
                (void *) udev_ctx);
        return 1;
    }

    struct libinput *path_ctx = libinput_path_create_context(NULL, NULL);
    if (path_ctx != NULL) {
        fprintf(stderr, "FAIL: libinput_path_create_context returned %p (expected NULL)\n",
                (void *) path_ctx);
        return 1;
    }

    /* No-ops on NULL — must not crash. */
    libinput_unref(NULL);
    int dispatch_rc = libinput_dispatch(NULL);
    if (dispatch_rc != 0) {
        fprintf(stderr, "FAIL: libinput_dispatch returned %d (expected 0)\n", dispatch_rc);
        return 1;
    }
    struct libinput_event *ev = libinput_get_event(NULL);
    if (ev != NULL) {
        fprintf(stderr, "FAIL: libinput_get_event returned %p (expected NULL)\n", (void *) ev);
        return 1;
    }

    printf("OK\n");
    return 0;
}
