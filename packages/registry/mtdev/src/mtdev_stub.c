/*
 * mtdev_stub.c — the five mtdev entry points libinput links, stubbed.
 *
 * libinput only calls into mtdev for legacy multitouch protocol-A
 * devices (`evdev_need_mtdev()` — has ABS_MT_POSITION_X/Y but no
 * ABS_MT_SLOT). The kernel's virtual pointer reports plain ABS_X/ABS_Y,
 * never the ABS_MT_* axes, so that predicate is always false and
 * `device->mtdev` stays NULL: none of these are reached at runtime. They
 * exist to satisfy the link. If one is ever actually called, a
 * protocol-A device slipped through and the A→B slot translation this
 * stub omits is genuinely needed — so fail loudly rather than silently
 * mis-handle touch input. See include/mtdev-plumbing.h.
 */
#include <mtdev-plumbing.h>

#include <stdio.h>
#include <stdlib.h>

static _Noreturn void mtdev_unreachable(const char *fn) {
    fprintf(stderr,
            "mtdev stub: %s() called, but the wasm-posix kernel exposes no "
            "protocol-A multitouch device (evdev_need_mtdev() should be "
            "false). A real mtdev port is required for this device.\n",
            fn);
    abort();
}

struct mtdev *mtdev_new_open(int fd) {
    (void) fd;
    mtdev_unreachable("mtdev_new_open");
}

void mtdev_put_event(struct mtdev *dev, const struct input_event *ev) {
    (void) dev;
    (void) ev;
    mtdev_unreachable("mtdev_put_event");
}

int mtdev_empty(struct mtdev *dev) {
    (void) dev;
    mtdev_unreachable("mtdev_empty");
}

void mtdev_get_event(struct mtdev *dev, struct input_event *ev) {
    (void) dev;
    (void) ev;
    mtdev_unreachable("mtdev_get_event");
}

void mtdev_close_delete(struct mtdev *dev) {
    (void) dev;
    mtdev_unreachable("mtdev_close_delete");
}
