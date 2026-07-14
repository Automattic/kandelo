/*
 * mtdev stub smoke test (PR5b), driven by host/test/mtdev-smoke.test.ts.
 *
 * The mtdev stub is link-only for our devices: libinput references five
 * mtdev symbols but calls them solely for legacy protocol-A multitouch
 * (`evdev_need_mtdev()` — has ABS_MT_POSITION_X/Y but no ABS_MT_SLOT).
 * This test proves both halves of that contract without libinput present:
 *   1. libmtdev.a links — the five symbols resolve.
 *   2. the kernel's virtual pointer is NOT protocol-A, so the predicate
 *      that would enter the stub is false and it is never called.
 */
#include <fcntl.h>
#include <linux/input.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include <mtdev-plumbing.h>

#define ABS_MT_SLOT_CODE 0x2f
#define ABS_MT_POSITION_X_CODE 0x35
#define ABS_MT_POSITION_Y_CODE 0x36
#define BITS_PER_LONG (sizeof(unsigned long) * 8)

/* 1 if the EV_ABS bitmap advertises `code`, 0 if not, -1 on ioctl error. */
static int has_abs_code(int fd, unsigned code) {
    unsigned long bits[(0x3f / BITS_PER_LONG) + 1] = { 0 };
    if (ioctl(fd, EVIOCGBIT(EV_ABS, sizeof bits), bits) < 0)
        return -1;
    return (bits[code / BITS_PER_LONG] >> (code % BITS_PER_LONG)) & 1UL;
}

int main(void) {
    /* Force the linker to pull in every mtdev symbol libinput links,
     * without calling any (the stub aborts if called; our devices never
     * reach that path). Taking the address is enough to require the
     * definition from libmtdev.a. */
    volatile uintptr_t linked = 0;
    linked |= (uintptr_t) &mtdev_new_open;
    linked |= (uintptr_t) &mtdev_put_event;
    linked |= (uintptr_t) &mtdev_empty;
    linked |= (uintptr_t) &mtdev_get_event;
    linked |= (uintptr_t) &mtdev_close_delete;
    printf("mtdev_linked=%d\n", linked != 0);

    int fd = open("/dev/input/event1", O_RDONLY);
    if (fd < 0) {
        perror("open");
        return 1;
    }
    int mt_x = has_abs_code(fd, ABS_MT_POSITION_X_CODE);
    int mt_y = has_abs_code(fd, ABS_MT_POSITION_Y_CODE);
    int slot = has_abs_code(fd, ABS_MT_SLOT_CODE);
    close(fd);
    printf("ptr abs_mt_x=%d abs_mt_y=%d abs_mt_slot=%d\n", mt_x, mt_y, slot);

    /* evdev_need_mtdev(): has MT_X && MT_Y && !MT_SLOT */
    int need_mtdev = (mt_x == 1) && (mt_y == 1) && (slot != 1);
    printf("evdev_need_mtdev=%d\n", need_mtdev);
    if (need_mtdev) {
        printf("unexpected: virtual pointer looks protocol-A\n");
        return 1;
    }

    printf("MTDEV_SMOKE_OK\n");
    return 0;
}
