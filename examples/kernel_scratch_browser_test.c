#define _GNU_SOURCE

#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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
    if (argc == 4 && strcmp(argv[1], "readv") == 0) {
        return test_readv(
            parse_size(argv[2], "readv iovec count"),
            parse_size(argv[3], "readv bytes per iovec"));
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
        "pty EXPECTED_LENGTH EXPECTED_BYTE\n",
        argv[0]);
    return 2;
}
