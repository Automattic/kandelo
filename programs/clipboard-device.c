/*
 * clipboard-device — /dev/kandelo/clipboard from a guest's point of view,
 * driven by host/test/clipboard-device.test.ts (wasm32 and wasm64).
 *
 * The host offers text with offerClipboardText() each time this program
 * prints a *_WAIT marker; the program checks what a C agent relies on:
 *
 *   - the node is a char device (misc major 10) listed under /dev/kandelo;
 *   - an empty device reads EAGAIN with O_NONBLOCK and polls not-readable;
 *   - a second process gets EBUSY while this one holds it (the test spawns
 *     `clipboard-device --expect-busy` for that: fork is wasm32-only);
 *   - a blocking read parks until the host offers, then returns exactly one
 *     record (header + text), never the start of the next;
 *   - a short buffer streams through a 1 MiB record;
 *   - the acknowledgement written back reaches the host (0 and an errno);
 *   - copy-out: a KIND_GUEST_TEXT record written in one write() reaches a
 *     host waiting for the desktop's selection, up to exactly the cap;
 *     malformed, non-UTF-8 and over-cap records are refused.
 *
 * Prints PASS lines and CLIPDEV_DONE; any failure exits 1 with the reason.
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#include <kandelo/clipboard.h>

#define CHECK(cond, ...)                                                    \
    do {                                                                    \
        if (!(cond)) {                                                      \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);                     \
            printf(__VA_ARGS__);                                            \
            printf(" (errno=%d %s)\n", errno, strerror(errno));             \
            fflush(stdout);                                                 \
            exit(1);                                                        \
        }                                                                   \
    } while (0)

static void say(const char *s) {
    printf("%s\n", s);
    fflush(stdout);
}

static void read_exact(int fd, void *buf, size_t len, size_t chunk) {
    size_t got = 0;
    while (got < len) {
        size_t want = len - got < chunk ? len - got : chunk;
        ssize_t n = read(fd, (char *)buf + got, want);
        CHECK(n > 0, "read returned %zd after %zu of %zu bytes", n, got, len);
        got += (size_t)n;
    }
}

/* One KIND_GUEST_TEXT record in one write(); returns write()'s result. */
static ssize_t write_guest(int fd, const char *text, size_t len, uint32_t claimed) {
    size_t total = sizeof(struct kandelo_clipboard_record) + len;
    char *buf = malloc(total);
    CHECK(buf != NULL, "malloc %zu", total);
    struct kandelo_clipboard_record h = {
        .version = KANDELO_CLIPBOARD_RECORD_VERSION,
        .kind = KANDELO_CLIPBOARD_KIND_GUEST_TEXT,
        .len = claimed,
    };
    memcpy(buf, &h, sizeof(h));
    memcpy(buf + sizeof(h), text, len);
    ssize_t n = write(fd, buf, total);
    int saved = errno;
    free(buf);
    errno = saved;
    return n;
}

static void await_go(void) {
    char go;
    CHECK(read(0, &go, 1) == 1, "waiting for the test's go-ahead on stdin");
}

static void ack(int fd, uint32_t seq, int32_t status) {
    struct kandelo_clipboard_ack a = { .seq = seq, .status = status };
    CHECK(write(fd, &a, sizeof(a)) == (ssize_t)sizeof(a), "ack write");
}

int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "--expect-busy")) {
        errno = 0;
        int other = open(KANDELO_CLIPBOARD_DEVICE_PATH, O_RDWR);
        CHECK(other < 0 && errno == EBUSY, "second process was not refused");
        say("CLIPDEV_BUSY_OK");
        return 0;
    }
    struct stat st;
    CHECK(stat(KANDELO_CLIPBOARD_DEVICE_PATH, &st) == 0, "stat");
    CHECK(S_ISCHR(st.st_mode), "not a char device: mode %o", st.st_mode);
    CHECK(major(st.st_rdev) == 10 && minor(st.st_rdev) == 250,
          "rdev %u:%u", major(st.st_rdev), minor(st.st_rdev));
    DIR *d = opendir("/dev/kandelo");
    CHECK(d != NULL, "opendir /dev/kandelo");
    int listed = 0;
    for (struct dirent *e; (e = readdir(d));)
        if (!strcmp(e->d_name, "clipboard")) listed = 1;
    closedir(d);
    CHECK(listed, "/dev/kandelo does not list clipboard");
    say("PASS node");

    int fd = open(KANDELO_CLIPBOARD_DEVICE_PATH, O_RDWR | O_CLOEXEC);
    CHECK(fd >= 0, "open");
    int nb = open(KANDELO_CLIPBOARD_DEVICE_PATH, O_RDWR | O_NONBLOCK | O_CLOEXEC);
    CHECK(nb >= 0, "re-open by the owner");
    char byte;
    errno = 0;
    CHECK(read(nb, &byte, 1) < 0 && errno == EAGAIN, "empty O_NONBLOCK read");
    struct pollfd p = { .fd = fd, .events = POLLIN };
    CHECK(poll(&p, 1, 0) == 0, "empty device polled readable");
    say("PASS empty");

    /* Held: a second process is refused (the test runs it now). */
    say("CLIPDEV_HELD");
    await_go();

    /* 1. A blocking read parks until the host offers. */
    say("CLIPDEV_WAIT_SMALL");
    struct kandelo_clipboard_record rec;
    char text[64];
    ssize_t n = read(fd, &rec, sizeof(rec));
    CHECK(n == (ssize_t)sizeof(rec), "header read %zd", n);
    CHECK(rec.version == KANDELO_CLIPBOARD_RECORD_VERSION &&
          rec.kind == KANDELO_CLIPBOARD_KIND_OFFER_TEXT && rec.len < sizeof(text),
          "header v%u k%u len %u", rec.version, rec.kind, rec.len);
    /* Ask for more than the record holds: the read stops at its end. */
    n = read(fd, text, sizeof(text));
    CHECK(n == (ssize_t)rec.len, "payload read %zd, record len %u", n, rec.len);
    text[n] = '\0';
    printf("CLIPDEV_GOT seq=%u len=%u text=%s\n", rec.seq, rec.len, text);
    fflush(stdout);
    ack(fd, rec.seq, 0);

    /* 2. A 1 MiB record streams through 4 KiB reads; poll wakes for it. */
    say("CLIPDEV_WAIT_LARGE");
    p.revents = 0;
    CHECK(poll(&p, 1, -1) == 1 && (p.revents & POLLIN), "poll for the large offer");
    read_exact(fd, &rec, sizeof(rec), sizeof(rec));
    char *big = malloc(rec.len);
    CHECK(big != NULL, "malloc %u", rec.len);
    read_exact(fd, big, rec.len, 4096);
    for (uint32_t i = 0; i < rec.len; i++)
        CHECK(big[i] == (char)('a' + i % 26), "large payload byte %u", i);
    free(big);
    errno = 0;
    CHECK(read(nb, &byte, 1) < 0 && errno == EAGAIN, "a second record appeared");
    printf("CLIPDEV_GOT_LARGE seq=%u len=%u\n", rec.seq, rec.len);
    fflush(stdout);
    ack(fd, rec.seq, -EIO);   /* the host must see the agent's own error */

    errno = 0;
    struct kandelo_clipboard_ack bad = { .seq = rec.seq, .status = 5 };
    CHECK(write(fd, &bad, sizeof(bad)) < 0 && errno == EINVAL,
          "a positive ack status was accepted");

    /* 3. Copy-out. Refusals first: none of them may reach the host. */
    static const char copied[] = "copi\xc3\xa9 in the guest";
    errno = 0;
    CHECK(write_guest(fd, copied, strlen(copied), strlen(copied) + 1) < 0 &&
          errno == EINVAL, "a record whose len disagrees with the write");
    errno = 0;
    CHECK(write_guest(fd, "\xff\xfe", 2, 2) < 0 && errno == EINVAL,
          "a non-UTF-8 record");
    char *over = malloc(KANDELO_CLIPBOARD_MAX_TEXT_BYTES + 1);
    CHECK(over != NULL, "malloc");
    memset(over, 'z', KANDELO_CLIPBOARD_MAX_TEXT_BYTES + 1);
    errno = 0;
    CHECK(write_guest(fd, over, KANDELO_CLIPBOARD_MAX_TEXT_BYTES + 1,
                      KANDELO_CLIPBOARD_MAX_TEXT_BYTES + 1) < 0 && errno == EMSGSIZE,
          "an over-cap record");
    say("PASS guest refusals");

    /* The host starts waiting, then lets this write. */
    say("CLIPDEV_COPY_READY");
    await_go();
    ssize_t want = (ssize_t)(sizeof(struct kandelo_clipboard_record) + strlen(copied));
    CHECK(write_guest(fd, copied, strlen(copied), strlen(copied)) == want,
          "guest record write");
    say("CLIPDEV_COPIED");

    /* Exactly the cap, in one write. */
    say("CLIPDEV_COPY_LARGE_READY");
    await_go();
    for (uint32_t i = 0; i < KANDELO_CLIPBOARD_MAX_TEXT_BYTES; i++)
        over[i] = (char)('a' + i % 26);
    CHECK(write_guest(fd, over, KANDELO_CLIPBOARD_MAX_TEXT_BYTES,
                      KANDELO_CLIPBOARD_MAX_TEXT_BYTES) ==
              (ssize_t)(sizeof(struct kandelo_clipboard_record) +
                        KANDELO_CLIPBOARD_MAX_TEXT_BYTES),
          "a 1 MiB guest record write");
    free(over);
    say("CLIPDEV_COPIED_LARGE");
    /* Hold the device until the host has read it: release drops the text. */
    await_go();
    close(nb);
    close(fd);
    say("CLIPDEV_DONE");
    return 0;
}
