#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <termios.h>
#include <unistd.h>

static void fail(const char *step)
{
    fprintf(stderr, "KERNEL_SCRATCH_BROWSER_FAIL: %s: %s\n",
        step, strerror(errno));
    exit(1);
}

static size_t parse_size(const char *text, const char *field)
{
    char *end = NULL;
    errno = 0;
    unsigned long long value = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' ||
        value == 0 || value > SIZE_MAX) {
        errno = EINVAL;
        fail(field);
    }
    return (size_t)value;
}

static void write_all(int fd, const unsigned char *bytes, size_t length,
    const char *step)
{
    size_t offset = 0;
    while (offset < length) {
        ssize_t written = write(fd, bytes + offset, length - offset);
        if (written < 0)
            fail(step);
        if (written == 0) {
            errno = EIO;
            fail(step);
        }
        offset += (size_t)written;
    }
}

static void expect_bytes_at(int fd, const unsigned char *expected,
    size_t length, const char *step)
{
    unsigned char actual[32];
    if (length > sizeof(actual)) {
        errno = EINVAL;
        fail(step);
    }
    ssize_t amount = pread(fd, actual, length, 0);
    if (amount < 0)
        fail(step);
    if ((size_t)amount != length || memcmp(actual, expected, length) != 0) {
        errno = EIO;
        fail(step);
    }
}

static void expect_zero_result(ssize_t amount, const char *step)
{
    if (amount != 0) {
        errno = EIO;
        fail(step);
    }
}

static void expect_errno_result(ssize_t amount, int expected,
    const char *step)
{
    if (amount != -1 || errno != expected) {
        errno = EIO;
        fail(step);
    }
}

static int test_append_flags(void)
{
    static const char path[] = "/tmp/kernel-scratch-append-flags";
    static const char renamed[] =
        "/tmp/kernel-scratch-append-flags-renamed";
    static const unsigned char expected_before_unlink[] = "aQYZ";
    static const unsigned char expected_after_append[] = "aQYZ!";
    static const unsigned char expected_after_clear[] = "BQYZ!";

    if (unlink(path) < 0 && errno != ENOENT)
        fail("remove stale append path");
    if (unlink(renamed) < 0 && errno != ENOENT)
        fail("remove stale renamed append path");

    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0)
        fail("open O_WRONLY append fixture");
    write_all(fd, (const unsigned char *)"abc", 3,
        "seed append fixture");
    int duplicate = dup(fd);
    if (duplicate < 0)
        fail("dup append fixture");

    int flags = fcntl(fd, F_GETFL);
    if (flags < 0)
        fail("get initial append flags");
    if ((flags & O_ACCMODE) != O_WRONLY || (flags & O_APPEND) != 0) {
        errno = EIO;
        fail("initial append flags");
    }
    if (lseek(fd, 1, SEEK_SET) != 1)
        fail("set append fixture cursor");
    if (fcntl(duplicate, F_SETFL, O_APPEND) < 0)
        fail("set append through duplicate");
    flags = fcntl(fd, F_GETFL);
    if (flags < 0)
        fail("get shared append flags");
    if ((flags & O_ACCMODE) != O_WRONLY || (flags & O_APPEND) == 0) {
        errno = EIO;
        fail("shared append flags");
    }

    write_all(fd, (const unsigned char *)"D", 1, "dynamic append write");
    if (lseek(duplicate, 0, SEEK_CUR) != 4) {
        errno = EIO;
        fail("dynamic append cursor");
    }
    if (pwrite(fd, "X", 1, 1) != 1)
        fail("append-independent pwrite");
    if (lseek(fd, 0, SEEK_CUR) != 4) {
        errno = EIO;
        fail("pwrite cursor neutrality");
    }

    unsigned char y = 'Y';
    unsigned char z = 'Z';
    struct iovec positioned[2] = {
        { .iov_base = &y, .iov_len = 1 },
        { .iov_base = &z, .iov_len = 1 },
    };
    if (pwritev(duplicate, positioned, 2, 2) != 2)
        fail("append-independent pwritev");
    if (lseek(fd, 0, SEEK_CUR) != 4) {
        errno = EIO;
        fail("pwritev cursor neutrality");
    }

    if (fcntl(fd, F_SETFL, 0) < 0)
        fail("clear append");
    flags = fcntl(duplicate, F_GETFL);
    if (flags < 0)
        fail("get cleared append flags");
    if ((flags & O_ACCMODE) != O_WRONLY || (flags & O_APPEND) != 0) {
        errno = EIO;
        fail("cleared append flags");
    }
    if (lseek(duplicate, 1, SEEK_SET) != 1)
        fail("set nonappend cursor");
    write_all(fd, (const unsigned char *)"Q", 1,
        "write after clearing append");
    if (lseek(duplicate, 0, SEEK_CUR) != 2) {
        errno = EIO;
        fail("cleared append cursor");
    }

    if (rename(path, renamed) < 0)
        fail("rename open append fixture");
    int reader = open(renamed, O_RDONLY);
    if (reader < 0)
        fail("open append verification reader");
    expect_bytes_at(reader, expected_before_unlink,
        sizeof(expected_before_unlink) - 1, "verify cleared append bytes");
    if (unlink(renamed) < 0)
        fail("unlink open append fixture");

    if (fcntl(duplicate, F_SETFL, O_APPEND) < 0)
        fail("set append after unlink");
    write_all(fd, (const unsigned char *)"!", 1,
        "append after rename and unlink");
    expect_bytes_at(reader, expected_after_append,
        sizeof(expected_after_append) - 1, "verify append after unlink");

    if (fcntl(fd, F_SETFL, 0) < 0)
        fail("clear append after unlink");
    if (lseek(duplicate, 0, SEEK_SET) != 0)
        fail("rewind unlinked append fixture");
    write_all(fd, (const unsigned char *)"B", 1,
        "positioned write after clearing unlinked append");
    expect_bytes_at(reader, expected_after_clear,
        sizeof(expected_after_clear) - 1, "verify clear after unlink");

    printf("KERNEL_SCRATCH_APPEND_FLAGS_PASS bytes=%zu\n",
        sizeof(expected_after_clear) - 1);
    if (close(reader) < 0)
        fail("close append verification reader");
    if (close(duplicate) < 0)
        fail("close append duplicate");
    if (close(fd) < 0)
        fail("close append fixture");
    return 0;
}

static int test_zero_iov(void)
{
    static const char path[] = "/tmp/kernel-scratch-zero-iov";
    struct iovec *invalid_iov =
        (struct iovec *)(uintptr_t)(UINTPTR_MAX - 15u);

    if (unlink(path) < 0 && errno != ENOENT)
        fail("remove stale zero-iov path");
    int read_write = open(path, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (read_write < 0)
        fail("open zero-iov fixture");
    int read_only = open(path, O_RDONLY);
    if (read_only < 0)
        fail("open zero-iov reader");
    int write_only = open(path, O_WRONLY);
    if (write_only < 0)
        fail("open zero-iov writer");
    int pipe_fds[2];
    if (pipe(pipe_fds) < 0)
        fail("open zero-iov pipe");

    expect_zero_result(readv(read_write, invalid_iov, 0),
        "readv zero count");
    expect_zero_result(writev(read_write, invalid_iov, 0),
        "writev zero count");
    expect_zero_result(preadv(read_write, invalid_iov, 0, 0),
        "preadv zero count");
    expect_zero_result(pwritev(read_write, invalid_iov, 0, 0),
        "pwritev zero count");

    errno = 0;
    expect_errno_result(readv(-1, invalid_iov, 0), EBADF,
        "readv zero invalid fd");
    errno = 0;
    expect_errno_result(writev(-1, invalid_iov, 0), EBADF,
        "writev zero invalid fd");
    errno = 0;
    expect_errno_result(readv(write_only, invalid_iov, 0), EBADF,
        "readv zero access");
    errno = 0;
    expect_errno_result(writev(read_only, invalid_iov, 0), EBADF,
        "writev zero access");

    errno = 0;
    expect_errno_result(preadv(-1, invalid_iov, 0, -1), EBADF,
        "preadv zero fd before offset");
    errno = 0;
    expect_errno_result(pwritev(-1, invalid_iov, 0, -1), EBADF,
        "pwritev zero fd before offset");
    errno = 0;
    expect_errno_result(preadv(write_only, invalid_iov, 0, -1), EINVAL,
        "preadv zero offset before access");
    errno = 0;
    expect_errno_result(pwritev(read_only, invalid_iov, 0, -1), EINVAL,
        "pwritev zero offset before access");
    errno = 0;
    expect_errno_result(preadv(write_only, invalid_iov, 0, 0), EBADF,
        "preadv zero access");
    errno = 0;
    expect_errno_result(pwritev(read_only, invalid_iov, 0, 0), EBADF,
        "pwritev zero access");
    errno = 0;
    expect_errno_result(preadv(pipe_fds[0], invalid_iov, 0, 0), ESPIPE,
        "preadv zero pipe seekability");
    errno = 0;
    expect_errno_result(pwritev(pipe_fds[1], invalid_iov, 0, 0), ESPIPE,
        "pwritev zero pipe seekability");

    printf("KERNEL_SCRATCH_ZERO_IOV_PASS pointer_bits=%zu\n",
        sizeof(uintptr_t) * CHAR_BIT);
    if (close(pipe_fds[1]) < 0 || close(pipe_fds[0]) < 0 ||
        close(write_only) < 0 || close(read_only) < 0 ||
        close(read_write) < 0)
        fail("close zero-iov fixtures");
    if (unlink(path) < 0)
        fail("unlink zero-iov fixture");
    return 0;
}

static int test_groups(void)
{
    gid_t initial[] = { 7000, 42, 9000 };
    gid_t output[5] = { 0, 0, 0, 0x5a5a, 0xa5a5 };

    if (setgroups(3, initial) < 0)
        fail("setgroups complete vector");
    int group_count = getgroups(0, NULL);
    if (group_count != 3) {
        fprintf(stderr, "getgroups count=%d errno=%d\n", group_count, errno);
        errno = EIO;
        fail("getgroups count query");
    }
    errno = 0;
    expect_errno_result(getgroups(2, output), EINVAL,
        "getgroups insufficient capacity");
    errno = 0;
    expect_errno_result(getgroups(1, NULL), EFAULT,
        "getgroups null output");
    if (getgroups(5, output) != 3 ||
        memcmp(output, initial, sizeof(initial)) != 0 ||
        output[3] != 0x5a5a || output[4] != 0xa5a5) {
        errno = EIO;
        fail("getgroups bounded copyback");
    }

    gid_t maximum[32];
    gid_t maximum_output[32];
    for (size_t index = 0; index < 32; index++)
        maximum[index] = (gid_t)(10000 + index * 7);
    if (setgroups(32, maximum) < 0)
        fail("setgroups maximum vector");
    if (getgroups(32, maximum_output) != 32 ||
        memcmp(maximum_output, maximum, sizeof(maximum)) != 0) {
        errno = EIO;
        fail("getgroups maximum vector");
    }
    errno = 0;
    expect_errno_result(setgroups(33, maximum), EINVAL,
        "setgroups oversized vector");
    errno = 0;
    expect_errno_result(setgroups(1, NULL), EFAULT,
        "setgroups null input");

    printf("KERNEL_SCRATCH_GROUPS_PASS pointer_bits=%zu groups=%zu\n",
        sizeof(uintptr_t) * CHAR_BIT, sizeof(maximum) / sizeof(maximum[0]));
    return 0;
}

static int test_readv(size_t iovec_count, size_t bytes_per_iovec)
{
    if (iovec_count > IOV_MAX ||
        bytes_per_iovec > SIZE_MAX / iovec_count) {
        errno = EINVAL;
        fail("readv dimensions");
    }
    size_t total = iovec_count * bytes_per_iovec;
    unsigned char *expected = malloc(total);
    unsigned char *actual = calloc(total, 1);
    struct iovec *iovecs = calloc(iovec_count, sizeof(*iovecs));
    if (expected == NULL || actual == NULL || iovecs == NULL)
        fail("readv allocation");

    for (size_t index = 0; index < total; index++)
        expected[index] = (unsigned char)(index * 131u + 17u);
    for (size_t index = 0; index < iovec_count; index++) {
        iovecs[index].iov_base = actual + index * bytes_per_iovec;
        iovecs[index].iov_len = bytes_per_iovec;
    }

    FILE *file = tmpfile();
    if (file == NULL)
        fail("tmpfile");
    int fd = fileno(file);
    write_all(fd, expected, total, "seed readv file");
    if (lseek(fd, 0, SEEK_SET) < 0)
        fail("rewind readv file");

    ssize_t amount = readv(fd, iovecs, (int)iovec_count);
    if (amount < 0)
        fail("readv");
    if ((size_t)amount != total || memcmp(actual, expected, total) != 0) {
        errno = EIO;
        fail("readv result");
    }

    printf("KERNEL_SCRATCH_READV_PASS iovecs=%zu bytes=%zu\n",
        iovec_count, total);
    fclose(file);
    free(iovecs);
    free(actual);
    free(expected);
    return 0;
}

static int test_datagram_vector(size_t iovec_count, size_t bytes_per_iovec)
{
    if (iovec_count < 2 || iovec_count > IOV_MAX ||
        bytes_per_iovec > SIZE_MAX / iovec_count) {
        errno = EINVAL;
        fail("datagram vector dimensions");
    }
    size_t total = iovec_count * bytes_per_iovec;
    unsigned char *expected = malloc(total);
    unsigned char *actual = calloc(total, 1);
    struct iovec *send_iovecs = calloc(iovec_count, sizeof(*send_iovecs));
    struct iovec *recv_iovecs = calloc(iovec_count, sizeof(*recv_iovecs));
    if (expected == NULL || actual == NULL ||
        send_iovecs == NULL || recv_iovecs == NULL)
        fail("datagram vector allocation");

    for (size_t index = 0; index < total; index++)
        expected[index] = (unsigned char)(index * 197u + 29u);
    for (size_t index = 0; index < iovec_count; index++) {
        send_iovecs[index].iov_base =
            expected + index * bytes_per_iovec;
        send_iovecs[index].iov_len = bytes_per_iovec;
        recv_iovecs[index].iov_base =
            actual + index * bytes_per_iovec;
        recv_iovecs[index].iov_len = bytes_per_iovec;
    }

    int pair[2];
    if (socketpair(AF_UNIX, SOCK_DGRAM | SOCK_NONBLOCK, 0, pair) < 0)
        fail("datagram socketpair");

    /*
     * A datagram is one indivisible operation. Splitting either vector into
     * channel-sized scalar calls would create or consume multiple messages,
     * which the amount check and empty-queue check below both detect.
     */
    ssize_t amount = writev(pair[0], send_iovecs, (int)iovec_count);
    if (amount < 0)
        fail("datagram writev");
    if ((size_t)amount != total) {
        errno = EIO;
        fail("datagram writev amount");
    }

    amount = readv(pair[1], recv_iovecs, (int)iovec_count);
    if (amount < 0)
        fail("datagram readv");
    if ((size_t)amount != total || memcmp(actual, expected, total) != 0) {
        errno = EIO;
        fail("datagram readv result");
    }

    unsigned char extra;
    amount = recv(pair[1], &extra, sizeof(extra), MSG_DONTWAIT);
    if (amount >= 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
        errno = EIO;
        fail("datagram vector message count");
    }

    printf("KERNEL_SCRATCH_DGRAM_VECTOR_PASS iovecs=%zu bytes=%zu "
        "datagrams=1\n", iovec_count, total);
    close(pair[1]);
    close(pair[0]);
    free(recv_iovecs);
    free(send_iovecs);
    free(actual);
    free(expected);
    return 0;
}

static int test_positioned_vector(size_t iovec_count,
    size_t bytes_per_iovec)
{
    static const char path[] = "/tmp/kernel-scratch-positioned-vector";
    const size_t fixed_offset = 4096;
    const size_t tail_guard = 4096;
    const off_t cursor_marker = 37;

    if (iovec_count < 2 || iovec_count > IOV_MAX ||
        bytes_per_iovec > SIZE_MAX / iovec_count) {
        errno = EINVAL;
        fail("positioned vector dimensions");
    }
    size_t total = iovec_count * bytes_per_iovec;
    if (total > SIZE_MAX - fixed_offset - tail_guard ||
        total > (size_t)INT64_MAX - fixed_offset - tail_guard) {
        errno = EOVERFLOW;
        fail("positioned vector file size");
    }
    size_t file_length = fixed_offset + total + tail_guard;

    unsigned char *expected = malloc(total);
    unsigned char *actual = calloc(total, 1);
    unsigned char *seed = malloc(file_length);
    struct iovec *write_iovecs = calloc(iovec_count, sizeof(*write_iovecs));
    struct iovec *read_iovecs = calloc(iovec_count, sizeof(*read_iovecs));
    if (expected == NULL || actual == NULL || seed == NULL ||
        write_iovecs == NULL || read_iovecs == NULL)
        fail("positioned vector allocation");

    memset(seed, 0x6b, file_length);
    for (size_t index = 0; index < total; index++)
        expected[index] = (unsigned char)(index * 149u + 43u);
    for (size_t index = 0; index < iovec_count; index++) {
        write_iovecs[index].iov_base =
            expected + index * bytes_per_iovec;
        write_iovecs[index].iov_len = bytes_per_iovec;
        read_iovecs[index].iov_base =
            actual + index * bytes_per_iovec;
        read_iovecs[index].iov_len = bytes_per_iovec;
    }

    if (unlink(path) < 0 && errno != ENOENT)
        fail("remove stale positioned vector file");
    int fd = open(path, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd < 0)
        fail("open positioned vector file");
    write_all(fd, seed, file_length, "seed positioned vector file");
    /*
     * Seed without append semantics: setup must not require a backend's
     * atomic-append authority. The operation under test begins only after the
     * same open file description has O_APPEND enabled.
     */
    if (fcntl(fd, F_SETFL, O_APPEND) < 0)
        fail("enable append for positioned vector");
    if (lseek(fd, cursor_marker, SEEK_SET) != cursor_marker)
        fail("set positioned vector cursor");

    /*
     * WHY: Linux's native pwrite can incorrectly honor O_APPEND. The Kandelo
     * host must still implement the POSIX positioned-write contract: overwrite
     * at the requested offset without changing the open-file-description
     * cursor. File size and target bytes distinguish an accidental append.
     */
    ssize_t amount = pwritev(fd, write_iovecs, (int)iovec_count,
        (off_t)fixed_offset);
    if (amount < 0)
        fail("pwritev");
    if ((size_t)amount != total) {
        errno = EIO;
        fail("pwritev amount");
    }
    if (lseek(fd, 0, SEEK_CUR) != cursor_marker) {
        errno = EIO;
        fail("pwritev cursor");
    }

    struct stat status;
    if (fstat(fd, &status) < 0)
        fail("stat positioned vector file");
    if (status.st_size != (off_t)file_length) {
        errno = EIO;
        fail("pwritev appended");
    }

    amount = preadv(fd, read_iovecs, (int)iovec_count,
        (off_t)fixed_offset);
    if (amount < 0)
        fail("preadv");
    if ((size_t)amount != total || memcmp(actual, expected, total) != 0) {
        errno = EIO;
        fail("preadv result");
    }
    if (lseek(fd, 0, SEEK_CUR) != cursor_marker) {
        errno = EIO;
        fail("preadv cursor");
    }

    unsigned char guard = 0;
    if (pread(fd, &guard, 1, (off_t)fixed_offset - 1) != 1 ||
        guard != 0x6b) {
        errno = EIO;
        fail("positioned vector leading guard");
    }
    if (pread(fd, &guard, 1, (off_t)(fixed_offset + total)) != 1 ||
        guard != 0x6b) {
        errno = EIO;
        fail("positioned vector trailing guard");
    }
    if (lseek(fd, 0, SEEK_CUR) != cursor_marker) {
        errno = EIO;
        fail("positioned vector guard cursor");
    }

    printf("KERNEL_SCRATCH_POSITIONED_VECTOR_PASS iovecs=%zu bytes=%zu "
        "offset=%zu cursor=%lld\n", iovec_count, total, fixed_offset,
        (long long)cursor_marker);
    if (close(fd) < 0)
        fail("close positioned vector file");
    if (unlink(path) < 0)
        fail("unlink positioned vector file");
    free(read_iovecs);
    free(write_iovecs);
    free(seed);
    free(actual);
    free(expected);
    return 0;
}

static int test_pty(size_t expected_length, unsigned char expected_byte)
{
    struct termios attributes;
    if (tcgetattr(STDIN_FILENO, &attributes) < 0)
        fail("tcgetattr");
    attributes.c_lflag &= ~(ICANON | ECHO | ECHONL);
    attributes.c_cc[VMIN] = 1;
    attributes.c_cc[VTIME] = 0;
    if (tcsetattr(STDIN_FILENO, TCSANOW, &attributes) < 0)
        fail("tcsetattr");

    /*
     * The browser harness waits for this marker before calling ptyWrite().
     * That ordering proves the guest has installed raw mode, so bytes cannot
     * be consumed by the prior canonical line discipline during worker races.
     */
    static const unsigned char ready[] = "KERNEL_SCRATCH_PTY_READY\n";
    write_all(STDOUT_FILENO, ready, sizeof(ready) - 1, "PTY ready marker");

    unsigned char *input = malloc(expected_length);
    if (input == NULL)
        fail("PTY input allocation");
    size_t received = 0;
    while (received < expected_length) {
        ssize_t amount = read(STDIN_FILENO, input + received,
            expected_length - received);
        if (amount < 0)
            fail("PTY input read");
        if (amount == 0) {
            errno = EIO;
            fail("PTY input EOF");
        }
        received += (size_t)amount;
    }
    for (size_t index = 0; index < expected_length; index++) {
        if (input[index] != expected_byte) {
            errno = EIO;
            fail("PTY input contents");
        }
    }

    printf("KERNEL_SCRATCH_PTY_PASS bytes=%zu\n", received);
    free(input);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "append-flags") == 0)
        return test_append_flags();
    if (argc == 2 && strcmp(argv[1], "zero-iov") == 0)
        return test_zero_iov();
    if (argc == 2 && strcmp(argv[1], "groups") == 0)
        return test_groups();
    if (argc == 4 && strcmp(argv[1], "readv") == 0) {
        return test_readv(
            parse_size(argv[2], "readv iovec count"),
            parse_size(argv[3], "readv bytes per iovec"));
    }
    if (argc == 4 && strcmp(argv[1], "dgram-vector") == 0) {
        return test_datagram_vector(
            parse_size(argv[2], "datagram vector iovec count"),
            parse_size(argv[3], "datagram vector bytes per iovec"));
    }
    if (argc == 4 && strcmp(argv[1], "positioned-vector") == 0) {
        return test_positioned_vector(
            parse_size(argv[2], "positioned vector iovec count"),
            parse_size(argv[3], "positioned vector bytes per iovec"));
    }
    if (argc == 4 && strcmp(argv[1], "pty") == 0) {
        size_t byte_value = parse_size(argv[3], "PTY byte value");
        if (byte_value > UCHAR_MAX) {
            errno = EINVAL;
            fail("PTY byte value");
        }
        return test_pty(
            parse_size(argv[2], "PTY expected length"),
            (unsigned char)byte_value);
    }

    fprintf(stderr,
        "usage: %s readv IOVEC_COUNT BYTES_PER_IOVEC | "
        "dgram-vector IOVEC_COUNT BYTES_PER_IOVEC | "
        "positioned-vector IOVEC_COUNT BYTES_PER_IOVEC | "
        "append-flags | zero-iov | groups | "
        "pty EXPECTED_LENGTH EXPECTED_BYTE\n",
        argv[0]);
    return 2;
}
