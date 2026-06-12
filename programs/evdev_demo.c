/*
 * evdev_demo — C1 compile proof and runtime backing for `/?demo=evdev`.
 *
 * Only in-tree consumer of `<linux/input.h>`: the _Static_assert below
 * fires at build time if the vendored header drifts away from the
 * kernel-side WpkInputEvent layout. input-evdev-smoke.c stays inline
 * on purpose so the B5 fixture's ABI check is independent of C1.
 */
#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

_Static_assert(sizeof(struct input_event) == 24,
    "struct input_event must be 24 bytes on wasm32 (musl 64-bit time_t)");

#define EV_BATCH 16

static void log_kbd(const struct input_event *e) {
    if (e->type == EV_KEY) {
        const char *state = e->value == 0 ? "up"
                          : e->value == 1 ? "down"
                          : "repeat";
        printf("key %s: code=%u\n", state, (unsigned) e->code);
        fflush(stdout);
    }
}

static void log_ptr(const struct input_event *e) {
    if (e->type == EV_REL) {
        printf("ptr rel code=%u value=%d\n",
               (unsigned) e->code, (int) e->value);
        fflush(stdout);
    } else if (e->type == EV_ABS) {
        printf("ptr abs code=%u value=%d\n",
               (unsigned) e->code, (int) e->value);
        fflush(stdout);
    }
}

int main(void) {
    int kbd = open("/dev/input/event0", O_RDONLY | O_CLOEXEC);
    if (kbd < 0) { perror("open /dev/input/event0"); return 1; }
    int ptr = open("/dev/input/event1", O_RDONLY | O_CLOEXEC);
    if (ptr < 0) { perror("open /dev/input/event1"); return 1; }

    char name[64] = {0};
    if (ioctl(kbd, EVIOCGNAME(sizeof name), name) < 0) {
        perror("EVIOCGNAME event0"); return 1;
    }
    printf("kbd: %s\n", name);
    if (ioctl(ptr, EVIOCGNAME(sizeof name), name) < 0) {
        perror("EVIOCGNAME event1"); return 1;
    }
    printf("ptr: %s\n", name);
    printf("ready: type or move the mouse over the canvas\n");
    fflush(stdout);

    struct pollfd pfds[2] = {
        { .fd = kbd, .events = POLLIN },
        { .fd = ptr, .events = POLLIN },
    };

    for (;;) {
        int n = poll(pfds, 2, -1);
        if (n < 0) {
            if (errno == EINTR) continue;
            perror("poll"); return 1;
        }
        struct input_event evs[EV_BATCH];
        if (pfds[0].revents & POLLIN) {
            ssize_t r = read(kbd, evs, sizeof evs);
            for (ssize_t i = 0; i < r / (ssize_t) sizeof(evs[0]); i++) {
                log_kbd(&evs[i]);
            }
        }
        if (pfds[1].revents & POLLIN) {
            ssize_t r = read(ptr, evs, sizeof evs);
            for (ssize_t i = 0; i < r / (ssize_t) sizeof(evs[0]); i++) {
                log_ptr(&evs[i]);
            }
        }
    }
}
