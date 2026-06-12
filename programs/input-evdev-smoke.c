/*
 * Three-phase fixture driven by host/test/input-evdev.test.ts. Structs
 * and ioctl numbers are inlined (not <linux/input.h>) so the B5 ABI
 * check stays independent of the C1 sysroot header land.
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define EV_SYN       0x00
#define EV_KEY       0x01
#define EV_REL       0x02
#define SYN_REPORT   0x00
#define SYN_DROPPED  0x03

#define EVIOC_DIR_READ   (2u << 30)
#define EVIOC_MAGIC      (0x45u << 8)      /* 'E' */
#define EVIOCGNAME(len)  (EVIOC_DIR_READ | (((unsigned)(len) & 0x3fffu) << 16) | EVIOC_MAGIC | 0x06u)
#define EVIOCGABS(axis)  (EVIOC_DIR_READ | ((24u) << 16) | EVIOC_MAGIC | (0x40u + ((unsigned)(axis) & 0x3fu)))

struct wpk_event {
    int64_t tv_sec;
    int32_t tv_usec;
    int32_t _pad;
    uint16_t ev_type;
    uint16_t code;
    int32_t value;
};

struct wpk_absinfo {
    int32_t value, minimum, maximum, fuzz, flat, resolution;
};

_Static_assert(sizeof(struct wpk_event) == 24, "WpkInputEvent must be 24 bytes");
_Static_assert(sizeof(struct wpk_absinfo) == 24, "WpkInputAbsinfo must be 24 bytes");

static void wait_sync(void) {
    char c;
    while (read(0, &c, 1) <= 0) { }
}

static void print_event(const char *tag, int idx, const struct wpk_event *e) {
    printf("%s_ev%d type=%u code=%u value=%d tv_sec=%lld tv_usec=%d\n",
           tag, idx, (unsigned)e->ev_type, (unsigned)e->code, (int)e->value,
           (long long)e->tv_sec, (int)e->tv_usec);
}

int main(void) {
    /* --- Phase 1: keyboard (event0) ----------------------------------- */
    int fd0 = open("/dev/input/event0", O_RDONLY);
    if (fd0 < 0) { perror("open event0"); return 1; }

    char name0[64] = {0};
    if (ioctl(fd0, EVIOCGNAME(sizeof(name0)), name0) < 0) {
        perror("EVIOCGNAME event0"); return 1;
    }
    printf("kbd_name=%s\n", name0);
    printf("READY:kbd\n");
    fflush(stdout);
    wait_sync();

    char buf0[48];
    ssize_t n0 = read(fd0, buf0, sizeof(buf0));
    if (n0 != 48) { fprintf(stderr, "kbd read returned %zd\n", n0); return 1; }
    struct wpk_event ke0, ke1;
    memcpy(&ke0, buf0,      sizeof(ke0));
    memcpy(&ke1, buf0 + 24, sizeof(ke1));
    print_event("kbd", 0, &ke0);
    print_event("kbd", 1, &ke1);
    fflush(stdout);

    /* --- Phase 2: pointer (event1) ------------------------------------ */
    int fd1 = open("/dev/input/event1", O_RDONLY);
    if (fd1 < 0) { perror("open event1"); return 1; }

    struct wpk_absinfo abs_x;
    if (ioctl(fd1, EVIOCGABS(0 /* ABS_X */), &abs_x) < 0) {
        perror("EVIOCGABS ABS_X"); return 1;
    }
    printf("ptr_abs_x_max=%d\n", (int)abs_x.maximum);
    printf("READY:ptr\n");
    fflush(stdout);
    wait_sync();

    char buf1[48];
    ssize_t n1 = read(fd1, buf1, sizeof(buf1));
    if (n1 != 48) { fprintf(stderr, "ptr read returned %zd\n", n1); return 1; }
    struct wpk_event pe0, pe1;
    memcpy(&pe0, buf1,      sizeof(pe0));
    memcpy(&pe1, buf1 + 24, sizeof(pe1));
    print_event("ptr", 0, &pe0);
    print_event("ptr", 1, &pe1);
    fflush(stdout);

    /* --- Phase 3: ring overflow on event0 ----------------------------- */
    printf("READY:overflow\n");
    fflush(stdout);
    wait_sync();

    /* Blocking read on an empty+clean ring returns 0 — drain terminator. */
    int count = 0, syn_dropped_at = -1, non_syn_dropped = 0;
    struct wpk_event last = {0};
    for (;;) {
        char rec[24];
        ssize_t n = read(fd0, rec, sizeof(rec));
        if (n == 0) break;
        if (n != 24) { fprintf(stderr, "drain short read %zd\n", n); return 1; }
        struct wpk_event ev;
        memcpy(&ev, rec, sizeof(ev));
        if (ev.ev_type == EV_SYN && ev.code == SYN_DROPPED) {
            if (syn_dropped_at < 0) syn_dropped_at = count;
        } else {
            non_syn_dropped++;
        }
        last = ev;
        count++;
        if (count > 1500) { fprintf(stderr, "drain runaway\n"); return 1; }
    }
    printf("ov_count=%d ov_syn_dropped_at=%d ov_real=%d ov_last_type=%u ov_last_code=%u\n",
           count, syn_dropped_at, non_syn_dropped,
           (unsigned)last.ev_type, (unsigned)last.code);
    fflush(stdout);

    close(fd0);
    close(fd1);
    return 0;
}
