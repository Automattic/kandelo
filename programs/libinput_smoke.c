/*
 * libinput port smoke test (PR5c), driven by host/test/libinput-smoke.test.ts.
 *
 * Exercises the REAL libinput 1.25.0 path backend end-to-end — the full
 * PR5a+PR5b+PR5c chain in one shot:
 *
 *   libinput_path_create_context()  → epoll fd + quirks context
 *   libinput_path_add_device(ev0)   → stat() the node, recover st_rdev
 *                                      (PR5b kernel fix), udev_device_new_
 *                                      from_devnum → input_id classification
 *                                      (libudev shim), evdev_device_new →
 *                                      libevdev_new_from_fd capability probe
 *                                      (libevdev), device accepted (ID_INPUT
 *                                      + KEYBOARD tags), DEVICE_ADDED queued
 *   libinput_dispatch()/get_event() → drain DEVICE_ADDED, then decode a
 *                                      host-injected EV_KEY into a
 *                                      LIBINPUT_EVENT_KEYBOARD_KEY
 *
 * The KEY phase specifically proves libinput's epoll+timerfd event loop sees
 * the kernel evdev fd become readable (sys_epoll_pwait → sys_poll → the evdev
 * ring readiness gate) and reads it through libevdev.
 *
 * One phase gate on a stdin byte so the host injects only after the device is
 * open (push_event fans out at injection time — an OFD must already exist).
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

#include <libinput.h>

/* libinput never opens paths itself — it delegates to the interface so the
 * caller keeps control of device access (seat/logind on Linux; a plain
 * open()/close() here). Returning -errno on failure is the documented
 * contract. */
static int open_restricted(const char *path, int flags, void *user_data) {
    (void)user_data;
    int fd = open(path, flags);
    return fd < 0 ? -errno : fd;
}
static void close_restricted(int fd, void *user_data) {
    (void)user_data;
    close(fd);
}
static const struct libinput_interface interface = {
    .open_restricted = open_restricted,
    .close_restricted = close_restricted,
};

static void wait_sync(void) {
    char c;
    while (read(0, &c, 1) <= 0) { }
}

/* Drain every currently-queued libinput event, printing one line each so the
 * host can assert on type/key/state. Returns the count drained. */
static int drain(struct libinput *li, const char *tag) {
    int n = 0;
    struct libinput_event *ev;
    while ((ev = libinput_get_event(li)) != NULL) {
        enum libinput_event_type t = libinput_event_get_type(ev);
        if (t == LIBINPUT_EVENT_KEYBOARD_KEY) {
            struct libinput_event_keyboard *k =
                libinput_event_get_keyboard_event(ev);
            printf("%s_ev%d type=%d key=%u state=%d\n", tag, n, (int)t,
                   libinput_event_keyboard_get_key(k),
                   (int)libinput_event_keyboard_get_key_state(k));
        } else {
            printf("%s_ev%d type=%d\n", tag, n, (int)t);
        }
        libinput_event_destroy(ev);
        n++;
    }
    return n;
}

int main(void) {
    struct libinput *li = libinput_path_create_context(&interface, NULL);
    if (!li) {
        fprintf(stderr, "libinput_path_create_context failed\n");
        _exit(1);
    }

    /* event0 = "wpk virtual keyboard". add_device runs the whole accept
     * chain; NULL means the device was rejected (bad st_rdev, missing
     * ID_INPUT tags, or an empty capability set). */
    struct libinput_device *dev =
        libinput_path_add_device(li, "/dev/input/event0");
    if (!dev) {
        fprintf(stderr, "libinput_path_add_device rejected event0\n");
        _exit(1);
    }
    printf("dev_name=%s\n", libinput_device_get_name(dev));

    /* DEVICE_ADDED is queued synchronously at add_device; dispatch then
     * drain it so the queue is empty before the injected key arrives. */
    libinput_dispatch(li);
    printf("added_count=%d\n", drain(li, "added"));
    printf("READY:key\n");
    fflush(stdout);
    wait_sync();

    /* Host injected EV_KEY KEY_A down + SYN_REPORT into event0's ring.
     * dispatch's epoll_wait sees the fd readable and reads via libevdev. */
    libinput_dispatch(li);
    printf("key_count=%d\n", drain(li, "key"));
    fflush(stdout);

    libinput_unref(li);
    printf("LIBINPUT_SMOKE_OK\n");
    fflush(stdout);
    return 0;
}
