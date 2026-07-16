/*
 * libevdev port smoke test (PR5a), driven by host/test/libevdev-smoke.test.ts.
 *
 * Exercises the exact libevdev surface libinput's evdev backend is built
 * on: libevdev_new_from_fd() (which does the EVIOCG* capability probing),
 * libevdev_get_name(), libevdev_has_event_type/code(), libevdev_next_event()
 * (LIBEVDEV_READ_FLAG_NORMAL), and the code/type name lookups. It opens the
 * kernel's two virtual evdev nodes and decodes host-injected events.
 *
 * Two phases, each gated on a stdin byte so the host injects only after the
 * device is open (push_event fans out at injection time — an OFD must exist).
 */
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

#include <libevdev/libevdev.h>

static void wait_sync(void) {
    char c;
    while (read(0, &c, 1) <= 0) { }
}

/* Open the node, build a libevdev from it (EVIOCG* probe), print its name
 * plus whether it advertises the given (type,code) capability. Returns the
 * libevdev handle, or aborts the process on failure. */
static struct libevdev *probe(const char *path, const char *tag,
                              unsigned type, unsigned code) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) { perror("open"); _exit(1); }

    struct libevdev *dev = NULL;
    int rc = libevdev_new_from_fd(fd, &dev);
    if (rc < 0) {
        fprintf(stderr, "%s: libevdev_new_from_fd failed: %d\n", tag, rc);
        _exit(1);
    }
    printf("%s_name=%s\n", tag, libevdev_get_name(dev));
    printf("%s_has_type=%d %s_has_code=%d\n", tag,
           libevdev_has_event_type(dev, type), tag,
           libevdev_has_event_code(dev, type, code));
    return dev;
}

/* Pull one event and print it with libevdev's own name lookups. */
static void next(struct libevdev *dev, const char *tag, int idx) {
    struct input_event ev;
    int rc = libevdev_next_event(dev, LIBEVDEV_READ_FLAG_NORMAL, &ev);
    if (rc != LIBEVDEV_READ_STATUS_SUCCESS) {
        fprintf(stderr, "%s: next_event rc=%d\n", tag, rc);
        _exit(1);
    }
    printf("%s_ev%d type=%u code=%u value=%d type_name=%s code_name=%s\n",
           tag, idx, ev.type, ev.code, ev.value,
           libevdev_event_type_get_name(ev.type),
           libevdev_event_code_get_name(ev.type, ev.code));
}

int main(void) {
    /* --- Phase 1: keyboard (event0), EV_KEY / KEY_A ------------------- */
    struct libevdev *kbd = probe("/dev/input/event0", "kbd", EV_KEY, KEY_A);
    printf("READY:kbd\n");
    fflush(stdout);
    wait_sync();
    next(kbd, "kbd", 0);   /* EV_KEY KEY_A 1 */
    next(kbd, "kbd", 1);   /* EV_SYN SYN_REPORT 0 */
    fflush(stdout);
    libevdev_free(kbd);

    /* --- Phase 2: pointer (event1), EV_REL / REL_X ------------------- */
    struct libevdev *ptr = probe("/dev/input/event1", "ptr", EV_REL, REL_X);
    printf("READY:ptr\n");
    fflush(stdout);
    wait_sync();
    next(ptr, "ptr", 0);   /* EV_REL REL_X 5 */
    next(ptr, "ptr", 1);   /* EV_SYN SYN_REPORT 0 */
    fflush(stdout);
    libevdev_free(ptr);

    printf("LIBEVDEV_SMOKE_OK\n");
    fflush(stdout);
    return 0;
}
