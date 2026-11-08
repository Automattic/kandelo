/*
 * Hot-plugged evdev device fixture, driven by
 * host/test/input-hotplug-evdev.test.ts (Node) and
 * apps/browser-demos/test/gamepad-evdev.spec.ts (browser). It prints a
 * READY marker before each phase, then waits on kernel state — the node
 * appearing, a record arriving, the device hanging up — so the host can act
 * without feeding stdin. Uses <linux/input.h> as an evdev consumer such as
 * SDL does.
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

/* Wait up to 20 s for the host to connect /dev/input/event2. */
static int wait_for_node(void) {
    struct stat st;
    for (int i = 0; i < 2000; i++) {
        if (stat("/dev/input/event2", &st) == 0) return 0;
        usleep(10000);
    }
    return -1;
}

static int test_bit(const unsigned char *bits, unsigned bit) {
    return (bits[bit / 8] >> (bit % 8)) & 1;
}

/* Print the /dev/input listing and its mtime, as a scanner sees them. */
static void scan(const char *tag) {
    struct stat st;
    if (stat("/dev/input", &st) != 0) {
        printf("%s_stat_errno=%d\n", tag, errno);
        return;
    }
    printf("%s_mtime=%lld\n", tag, (long long)st.st_mtime);
    DIR *dir = opendir("/dev/input");
    if (!dir) {
        printf("%s_opendir_errno=%d\n", tag, errno);
        return;
    }
    printf("%s_nodes=", tag);
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strncmp(entry->d_name, "event", 5) == 0) printf("%s,", entry->d_name);
    }
    printf("\n");
    closedir(dir);
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);

    scan("before");
    printf("READY:connect\n");
    if (wait_for_node() != 0) {
        printf("no event2 appeared\n");
        return 1;
    }

    scan("connected");
    int fd = open("/dev/input/event2", O_RDONLY | O_NONBLOCK);
    if (fd < 0) {
        printf("open_errno=%d\n", errno);
        return 1;
    }

    char name[128] = {0};
    if (ioctl(fd, EVIOCGNAME(sizeof(name)), name) < 0) { perror("EVIOCGNAME"); return 1; }
    printf("name=%s\n", name);

    struct input_id id;
    if (ioctl(fd, EVIOCGID, &id) < 0) { perror("EVIOCGID"); return 1; }
    printf("id=%04x:%04x:%04x:%04x\n", id.bustype, id.vendor, id.product, id.version);

    unsigned char types[EV_MAX / 8 + 1] = {0};
    unsigned char keys[KEY_MAX / 8 + 1] = {0};
    unsigned char axes[ABS_MAX / 8 + 1] = {0};
    if (ioctl(fd, EVIOCGBIT(0, sizeof(types)), types) < 0) { perror("EVIOCGBIT"); return 1; }
    if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(keys)), keys) < 0) { perror("EVIOCGBIT key"); return 1; }
    if (ioctl(fd, EVIOCGBIT(EV_ABS, sizeof(axes)), axes) < 0) { perror("EVIOCGBIT abs"); return 1; }
    printf("types key=%d abs=%d rel=%d\n",
           test_bit(types, EV_KEY), test_bit(types, EV_ABS), test_bit(types, EV_REL));
    printf("keys a=%d b=%d x=%d y=%d start=%d left=%d\n",
           test_bit(keys, BTN_A), test_bit(keys, BTN_B), test_bit(keys, BTN_X),
           test_bit(keys, BTN_Y), test_bit(keys, BTN_START), test_bit(keys, BTN_LEFT));
    printf("axes x=%d y=%d rz=%d hat0x=%d\n",
           test_bit(axes, ABS_X), test_bit(axes, ABS_Y), test_bit(axes, ABS_RZ),
           test_bit(axes, ABS_HAT0X));

    struct input_absinfo abs;
    if (ioctl(fd, EVIOCGABS(ABS_X), &abs) < 0) { perror("EVIOCGABS"); return 1; }
    printf("abs_x value=%d min=%d max=%d fuzz=%d flat=%d\n",
           abs.value, abs.minimum, abs.maximum, abs.fuzz, abs.flat);

    printf("READY:events\n");
    struct pollfd pfd = { .fd = fd, .events = POLLIN };
    if (poll(&pfd, 1, 20000) != 1 || !(pfd.revents & POLLIN)) {
        printf("no record arrived revents=%d\n", pfd.revents);
        return 1;
    }

    struct input_event events[16];
    ssize_t n = read(fd, events, sizeof(events));
    if (n < 0) {
        printf("read_errno=%d\n", errno);
        return 1;
    }
    for (ssize_t i = 0; i < n / (ssize_t)sizeof(events[0]); i++) {
        printf("ev%zd type=%u code=%u value=%d\n", i, events[i].type, events[i].code, events[i].value);
    }
    if (ioctl(fd, EVIOCGABS(ABS_X), &abs) < 0) { perror("EVIOCGABS"); return 1; }
    printf("abs_x_now=%d\n", abs.value);
    memset(keys, 0, sizeof(keys));
    if (ioctl(fd, EVIOCGKEY(sizeof(keys)), keys) < 0) { perror("EVIOCGKEY"); return 1; }
    printf("pressed a=%d b=%d\n", test_bit(keys, BTN_A), test_bit(keys, BTN_B));

    printf("READY:disconnect\n");
    pfd.revents = 0;
    int ready = poll(&pfd, 1, 20000);
    printf("poll ready=%d hup=%d err=%d\n", ready,
           (pfd.revents & POLLHUP) != 0, (pfd.revents & POLLERR) != 0);
    errno = 0;
    n = read(fd, events, sizeof(events));
    printf("read_after n=%zd errno=%d\n", n, errno);
    errno = 0;
    int r = ioctl(fd, EVIOCGNAME(sizeof(name)), name);
    printf("ioctl_after r=%d errno=%d\n", r, errno);
    errno = 0;
    int again = open("/dev/input/event2", O_RDONLY | O_NONBLOCK);
    printf("reopen fd=%d errno=%d\n", again, errno);
    close(fd);
    scan("disconnected");
    printf("DONE\n");
    return 0;
}
