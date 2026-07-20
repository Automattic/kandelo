#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

struct pty_pair {
    int master;
    int slave;
};

enum {
    KANDELO_SYS_TCGETATTR = 70,
    KANDELO_SYS_TCSETATTR = 71,
    KANDELO_LEGACY_TERMIOS_SIZE = 48,
    KANDELO_LEGACY_BUFFER_SIZE = 256,
};

static void fail(const char *what)
{
    fprintf(stderr, "TERMINAL_ATTRIBUTES_API_FAIL: %s: %s\n", what,
            strerror(errno));
    exit(1);
}

static void check(int condition, const char *what)
{
    if (!condition) {
        errno = EINVAL;
        fail(what);
    }
}

static void write_all(int fd, const void *data, size_t length, const char *what)
{
    const unsigned char *bytes = data;
    size_t written = 0;
    while (written < length) {
        ssize_t amount = write(fd, bytes + written, length - written);
        if (amount < 0) fail(what);
        check(amount > 0, what);
        written += (size_t)amount;
    }
}

static void expect_read(int fd, const void *expected, size_t length, const char *what)
{
    unsigned char buffer[64];
    check(length <= sizeof(buffer), "test read length");
    ssize_t amount = read(fd, buffer, length);
    if (amount < 0) fail(what);
    check((size_t)amount == length, what);
    check(memcmp(buffer, expected, length) == 0, what);
}

static void expect_eagain(int fd, const char *what)
{
    unsigned char byte;
    errno = 0;
    check(read(fd, &byte, 1) == -1, what);
    check(errno == EAGAIN || errno == EWOULDBLOCK, what);
}

static int bytes_available(int fd)
{
    int available = -1;
    if (ioctl(fd, FIONREAD, &available) < 0) fail("FIONREAD");
    return available;
}

static int read_events(int fd)
{
    struct pollfd pollfd = { .fd = fd, .events = POLLIN, .revents = 0 };
    int result = poll(&pollfd, 1, 0);
    if (result < 0) fail("poll");
    return pollfd.revents;
}

static struct termios attributes(int fd)
{
    struct termios value;
    if (tcgetattr(fd, &value) < 0) fail("tcgetattr");
    return value;
}

static void expect_termios(const struct termios *actual,
                           const struct termios *expected,
                           const char *what)
{
    check(actual->c_iflag == expected->c_iflag, what);
    check(actual->c_oflag == expected->c_oflag, what);
    check(actual->c_cflag == expected->c_cflag, what);
    check(actual->c_lflag == expected->c_lflag, what);
    check(actual->c_line == expected->c_line, what);
    check(memcmp(actual->c_cc, expected->c_cc, NCCS) == 0, what);
    check(actual->__c_ispeed == expected->__c_ispeed, what);
    check(actual->__c_ospeed == expected->__c_ospeed, what);
}

static int legacy_tcgetattr(int fd, unsigned char buffer[KANDELO_LEGACY_BUFFER_SIZE])
{
    memset(buffer, 0xa5, KANDELO_LEGACY_BUFFER_SIZE);
    return (int)syscall(KANDELO_SYS_TCGETATTR, (long)fd,
                        (long)(uintptr_t)buffer, 0L, 0L, 0L, 0L);
}

static int legacy_tcsetattr(int fd, int action,
                            unsigned char buffer[KANDELO_LEGACY_BUFFER_SIZE])
{
    return (int)syscall(KANDELO_SYS_TCSETATTR, (long)fd, (long)action,
                        (long)(uintptr_t)buffer, 0L, 0L, 0L);
}

static uint32_t legacy_lflag(const unsigned char *buffer)
{
    uint32_t value;
    memcpy(&value, buffer + 12, sizeof(value));
    return value;
}

static void legacy_set_lflag(unsigned char *buffer, uint32_t value)
{
    memcpy(buffer + 12, &value, sizeof(value));
}

static void set_canonical(int fd, int enabled, int action)
{
    struct termios value = attributes(fd);
    if (enabled)
        value.c_lflag |= ICANON;
    else
        value.c_lflag &= ~ICANON;
    value.c_lflag &= ~(ECHO | ECHONL);
    value.c_cc[VMIN] = 1;
    value.c_cc[VTIME] = 0;
    if (tcsetattr(fd, action, &value) < 0) fail("tcsetattr mode change");
}

static struct pty_pair open_pair(void)
{
    struct pty_pair pair = { .master = -1, .slave = -1 };
    char path[64];

    pair.master = posix_openpt(O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (pair.master < 0) fail("posix_openpt");
    if (grantpt(pair.master) < 0) fail("grantpt");
    if (unlockpt(pair.master) < 0) fail("unlockpt");
    if (ptsname_r(pair.master, path, sizeof(path)) != 0) fail("ptsname_r");
    pair.slave = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (pair.slave < 0) fail("open PTY slave");

    set_canonical(pair.slave, 1, TCSANOW);
    if (tcflush(pair.slave, TCIOFLUSH) < 0) fail("initial tcflush");
    return pair;
}

static void reset_pair(struct pty_pair pair)
{
    set_canonical(pair.slave, 1, TCSANOW);
    if (tcflush(pair.master, TCIOFLUSH) < 0) fail("reset tcflush");
}

static void test_transition_action(struct pty_pair pair, int action, int use_master)
{
    int terminal = use_master ? pair.master : pair.slave;
    reset_pair(pair);

    write_all(pair.master, "line\nq", 6, "seed canonical input");
    write_all(pair.slave, "screen", 6, "seed terminal output");
    expect_read(pair.slave, "line\n", 5, "read completed canonical line");
    check(bytes_available(pair.slave) == 0, "partial canonical FIONREAD");
    check((read_events(pair.slave) & POLLIN) == 0, "partial canonical poll");

    set_canonical(terminal, 0, action);
    if (action == TCSAFLUSH) {
        check(bytes_available(pair.slave) == 0, "canonical-to-raw flush FIONREAD");
        check((read_events(pair.slave) & POLLIN) == 0, "canonical-to-raw flush poll");
        expect_eagain(pair.slave, "canonical-to-raw flush read");
    } else {
        check(bytes_available(pair.slave) == 1, "canonical-to-raw preserve FIONREAD");
        check((read_events(pair.slave) & POLLIN) != 0, "canonical-to-raw preserve poll");
        expect_read(pair.slave, "q", 1, "canonical-to-raw preserve read");
    }
    expect_read(pair.master, "screen", 6, "attribute flush preserves output");

    write_all(pair.master, "xyz", 3, "seed raw input");
    write_all(pair.slave, "display", 7, "seed raw transition output");
    expect_read(pair.slave, "x", 1, "partially read raw input");
    check(bytes_available(pair.slave) == 2, "unread raw FIONREAD");
    set_canonical(terminal, 1, action);
    if (action == TCSAFLUSH) {
        check(bytes_available(pair.slave) == 0, "raw-to-canonical flush FIONREAD");
        check((read_events(pair.slave) & POLLIN) == 0, "raw-to-canonical flush poll");
        expect_eagain(pair.slave, "raw-to-canonical flush read");
    } else {
        check(bytes_available(pair.slave) == 2, "raw-to-canonical preserve FIONREAD");
        check((read_events(pair.slave) & POLLIN) != 0, "raw-to-canonical preserve poll");
        expect_read(pair.slave, "yz", 2, "raw-to-canonical EOF-push read");
    }
    expect_read(pair.master, "display", 7, "raw transition preserves output");
}

static void test_delimited_and_edited_order(struct pty_pair pair)
{
    unsigned char sequence[64];
    size_t length = 0;
    struct termios value;

    reset_pair(pair);
    value = attributes(pair.slave);
    memcpy(sequence + length, "first", 5); length += 5;
    sequence[length++] = value.c_cc[VEOF];
    memcpy(sequence + length, "garbage", 7); length += 7;
    sequence[length++] = value.c_cc[VKILL];
    memcpy(sequence + length, "secondx", 7); length += 7;
    sequence[length++] = value.c_cc[VERASE];
    sequence[length++] = '!';
    write_all(pair.master, sequence, length, "seed edited canonical input");

    expect_read(pair.slave, "fi", 2, "partial VEOF-delimited read");
    check(bytes_available(pair.slave) == 3, "VEOF suffix FIONREAD");
    set_canonical(pair.master, 0, TCSADRAIN);
    check(bytes_available(pair.slave) == 10, "edited transition FIONREAD");
    expect_read(pair.slave, "rstsecond!", 10, "edited transition byte order");
}

static void seed_input_and_output(struct pty_pair pair)
{
    reset_pair(pair);
    write_all(pair.master, "line\npartial", 12, "seed flush input");
    write_all(pair.slave, "screen", 6, "seed flush output");
    check(bytes_available(pair.slave) == 5, "seed flush FIONREAD");
}

static void test_tcflush_selectors(struct pty_pair pair)
{
    const int queues[] = { TCIFLUSH, TCOFLUSH, TCIOFLUSH };
    size_t endpoint_index;
    size_t queue_index;

    for (endpoint_index = 0; endpoint_index < 2; endpoint_index++) {
        int terminal = endpoint_index == 0 ? pair.master : pair.slave;
        for (queue_index = 0; queue_index < sizeof(queues) / sizeof(queues[0]);
             queue_index++) {
            int queue = queues[queue_index];
            seed_input_and_output(pair);
            if (tcflush(terminal, queue) < 0) fail("tcflush selector matrix");

            if (queue == TCIFLUSH || queue == TCIOFLUSH) {
                check(bytes_available(pair.slave) == 0, "tcflush clears input");
                expect_eagain(pair.slave, "tcflush cleared input read");
            } else {
                check(bytes_available(pair.slave) == 5, "tcflush preserves input");
                expect_read(pair.slave, "line\n", 5, "tcflush completed line");
                set_canonical(pair.slave, 0, TCSANOW);
                expect_read(pair.slave, "partial", 7, "tcflush partial line");
            }

            if (queue == TCOFLUSH || queue == TCIOFLUSH)
                expect_eagain(pair.master, "tcflush clears output");
            else
                expect_read(pair.master, "screen", 6, "tcflush preserves output");
        }

        seed_input_and_output(pair);
        errno = 0;
        check(tcflush(terminal, 99) == -1, "invalid tcflush result");
        check(errno == EINVAL, "invalid tcflush errno");
        check(bytes_available(pair.slave) == 5, "invalid tcflush preserves input");
        expect_read(pair.master, "screen", 6, "invalid tcflush preserves output");
        expect_read(pair.slave, "line\n", 5, "invalid tcflush completed line");
        set_canonical(pair.slave, 0, TCSANOW);
        expect_read(pair.slave, "partial", 7, "invalid tcflush partial line");
    }
}

static void test_invalid_tcsetattr_is_non_mutating(struct pty_pair pair)
{
    size_t endpoint_index;

    for (endpoint_index = 0; endpoint_index < 2; endpoint_index++) {
        int terminal = endpoint_index == 0 ? pair.master : pair.slave;
        struct termios before;
        struct termios changed;
        struct termios after;

        seed_input_and_output(pair);
        before = attributes(terminal);
        changed = before;
        changed.c_lflag &= ~ICANON;
        errno = 0;
        check(tcsetattr(terminal, 99, &changed) == -1,
              "invalid tcsetattr result");
        check(errno == EINVAL, "invalid tcsetattr errno");
        after = attributes(terminal);
        expect_termios(&after, &before, "invalid tcsetattr attributes");
        check(bytes_available(pair.slave) == 5,
              "invalid tcsetattr preserves input");
        expect_read(pair.master, "screen", 6,
                    "invalid tcsetattr preserves output");
        expect_read(pair.slave, "line\n", 5,
                    "invalid tcsetattr completed line");
        set_canonical(pair.slave, 0, TCSANOW);
        expect_read(pair.slave, "partial", 7,
                    "invalid tcsetattr partial line");
    }
}

static void test_standard_termios_roundtrip(struct pty_pair pair)
{
    size_t endpoint_index;

    for (endpoint_index = 0; endpoint_index < 2; endpoint_index++) {
        int setter = endpoint_index == 0 ? pair.master : pair.slave;
        int getter = endpoint_index == 0 ? pair.slave : pair.master;
        struct termios original;
        struct termios changed;
        struct termios observed;
        size_t i;

        reset_pair(pair);
        original = attributes(setter);
        changed = original;
        changed.c_iflag = IGNBRK | INLCR | IXOFF | IUTF8;
        changed.c_oflag = OPOST | OCRNL | ONOCR | TAB1;
        changed.c_cflag = CS7 | CREAD | PARENB | PARODD | CLOCAL | B9600;
        changed.c_lflag = ISIG | ICANON | ECHOE | NOFLSH | IEXTEN;
        changed.c_line = 7;
        for (i = 0; i < NCCS; i++) changed.c_cc[i] = (cc_t)(0x20 + i);
        changed.__c_ispeed = B57600;
        changed.__c_ospeed = B115200;

        if (tcsetattr(setter, TCSANOW, &changed) < 0)
            fail("tcsetattr full roundtrip");
        observed = attributes(getter);
        expect_termios(&observed, &changed, "full termios roundtrip");
        if (tcsetattr(getter, TCSANOW, &original) < 0)
            fail("restore full termios roundtrip");
    }
}

static void test_legacy_channel(struct pty_pair pair)
{
    const int actions[] = { TCSANOW, TCSADRAIN, TCSAFLUSH };
    unsigned char original[KANDELO_LEGACY_BUFFER_SIZE];
    unsigned char changed[KANDELO_LEGACY_BUFFER_SIZE];
    unsigned char observed[KANDELO_LEGACY_BUFFER_SIZE];
    size_t action_index;
    size_t endpoint_index;
    size_t i;

    reset_pair(pair);
    if (legacy_tcgetattr(pair.master, original) < 0)
        fail("legacy tcgetattr roundtrip source");
    memcpy(changed, original, sizeof(changed));
    {
        const uint32_t flags[] = {
            IGNBRK | INLCR | IXOFF | IUTF8,
            OPOST | OCRNL | ONOCR | TAB1,
            CS7 | CREAD | PARENB | PARODD | CLOCAL | B9600,
            ISIG | ICANON | ECHOE | NOFLSH | IEXTEN,
        };
        memcpy(changed, flags, sizeof(flags));
    }
    for (i = 0; i < NCCS; i++) changed[16 + i] = (unsigned char)(0x40 + i);
    if (legacy_tcsetattr(pair.slave, TCSANOW, changed) < 0)
        fail("legacy tcsetattr roundtrip");
    if (legacy_tcgetattr(pair.master, observed) < 0)
        fail("legacy tcgetattr roundtrip result");
    check(memcmp(observed, changed, KANDELO_LEGACY_TERMIOS_SIZE) == 0,
          "legacy 48-byte roundtrip");
    if (legacy_tcsetattr(pair.master, TCSANOW, original) < 0)
        fail("restore legacy termios");

    for (action_index = 0;
         action_index < sizeof(actions) / sizeof(actions[0]); action_index++) {
        int action = actions[action_index];
        reset_pair(pair);
        write_all(pair.master, "pending", 7, "seed legacy pending input");
        if (legacy_tcgetattr(pair.slave, changed) < 0)
            fail("legacy action tcgetattr");
        legacy_set_lflag(changed, legacy_lflag(changed) & ~ICANON);
        if (legacy_tcsetattr(pair.slave, action, changed) < 0)
            fail("legacy action tcsetattr");
        if (action == TCSAFLUSH)
            expect_eagain(pair.slave, "legacy TCSAFLUSH input");
        else
            expect_read(pair.slave, "pending", 7, "legacy preserved input");
    }

    for (endpoint_index = 0; endpoint_index < 2; endpoint_index++) {
        int terminal = endpoint_index == 0 ? pair.master : pair.slave;
        reset_pair(pair);
        write_all(pair.master, "legacy", 6, "seed invalid legacy input");
        if (legacy_tcgetattr(terminal, original) < 0)
            fail("legacy invalid source");
        memcpy(changed, original, sizeof(changed));
        legacy_set_lflag(changed, legacy_lflag(changed) & ~ICANON);
        errno = 0;
        check(legacy_tcsetattr(terminal, 99, changed) == -1,
              "invalid legacy tcsetattr result");
        check(errno == EINVAL, "invalid legacy tcsetattr errno");
        if (legacy_tcgetattr(terminal, observed) < 0)
            fail("legacy invalid result");
        check(memcmp(observed, original, KANDELO_LEGACY_TERMIOS_SIZE) == 0,
              "invalid legacy tcsetattr attributes");
        set_canonical(pair.slave, 0, TCSANOW);
        expect_read(pair.slave, "legacy", 6,
                    "invalid legacy tcsetattr preserves input");
    }
}

static void expect_api_error(int result, int expected_errno, const char *what)
{
    check(result == -1, what);
    check(errno == expected_errno, what);
}

static void test_error_shapes(struct pty_pair pair)
{
    const char *regular_path = "/tmp/terminal-attributes-api-regular";
    struct termios value = attributes(pair.slave);
    unsigned char legacy[KANDELO_LEGACY_BUFFER_SIZE];
    int regular = open(regular_path, O_CREAT | O_TRUNC | O_RDWR, 0600);
    if (regular < 0) fail("open regular error-shape file");

    errno = 0;
    expect_api_error(tcgetattr(-1, &value), EBADF, "tcgetattr EBADF");
    errno = 0;
    expect_api_error(tcsetattr(-1, TCSANOW, &value), EBADF,
                     "tcsetattr EBADF");
    errno = 0;
    expect_api_error(tcflush(-1, TCIFLUSH), EBADF, "tcflush EBADF");
    errno = 0;
    expect_api_error(tcgetattr(regular, &value), ENOTTY, "tcgetattr ENOTTY");
    errno = 0;
    expect_api_error(tcsetattr(regular, TCSANOW, &value), ENOTTY,
                     "tcsetattr ENOTTY");
    errno = 0;
    expect_api_error(tcflush(regular, TCIFLUSH), ENOTTY, "tcflush ENOTTY");

    errno = 0;
    expect_api_error(legacy_tcgetattr(-1, legacy), EBADF,
                     "legacy tcgetattr EBADF");
    errno = 0;
    expect_api_error(legacy_tcsetattr(-1, TCSANOW, legacy), EBADF,
                     "legacy tcsetattr EBADF");
    errno = 0;
    expect_api_error(legacy_tcgetattr(regular, legacy), ENOTTY,
                     "legacy tcgetattr ENOTTY");
    errno = 0;
    expect_api_error(legacy_tcsetattr(regular, TCSANOW, legacy), ENOTTY,
                     "legacy tcsetattr ENOTTY");

    if (close(regular) < 0) fail("close regular error-shape file");
    if (unlink(regular_path) < 0) fail("unlink regular error-shape file");
}

static void test_hangup(struct pty_pair *pair)
{
    reset_pair(*pair);
    if (close(pair->master) < 0) fail("close PTY master");
    pair->master = -1;
    check((read_events(pair->slave) & POLLHUP) != 0, "slave POLLHUP");
    {
        unsigned char byte;
        check(read(pair->slave, &byte, 1) == 0, "slave EOF after hangup");
    }
}

int main(void)
{
    struct pty_pair pair = open_pair();
    const int actions[] = { TCSANOW, TCSADRAIN, TCSAFLUSH };
    size_t action_index;
    size_t endpoint_index;

    test_standard_termios_roundtrip(pair);
    for (action_index = 0;
         action_index < sizeof(actions) / sizeof(actions[0]); action_index++) {
        for (endpoint_index = 0; endpoint_index < 2; endpoint_index++)
            test_transition_action(pair, actions[action_index], endpoint_index != 0);
    }
    test_delimited_and_edited_order(pair);
    test_tcflush_selectors(pair);
    test_invalid_tcsetattr_is_non_mutating(pair);
    test_legacy_channel(pair);
    test_error_shapes(pair);
    test_hangup(&pair);

    if (close(pair.slave) < 0) fail("close PTY slave");
    puts("TERMINAL_ATTRIBUTES_API_PASS");
    return 0;
}
