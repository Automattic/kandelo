#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int expect_failure(int fd, off_t offset, int whence, int expected_errno)
{
    errno = 0;
    if (lseek(fd, offset, whence) != (off_t)-1 || errno != expected_errno) {
        fprintf(stderr, "lseek(%lld, %d): errno=%d (%s), expected %d\n",
                (long long)offset, whence, errno, strerror(errno), expected_errno);
        return -1;
    }
    if (lseek(fd, 0, SEEK_CUR) != 2) {
        fputs("invalid seek changed the file offset\n", stderr);
        return -1;
    }
    return 0;
}

int main(int argc, char **argv)
{
    if (argc > 2) {
        fprintf(stderr, "usage: %s [FILE]\n", argv[0]);
        return 2;
    }
    const char *path = argc == 2 ? argv[1] : "/tmp/lseek-invalid.bin";

    int fd = open(path, O_CREAT | O_TRUNC | O_RDWR, 0600);
    if (fd < 0 || write(fd, "abcdef", 6) != 6 || lseek(fd, 2, SEEK_SET) != 2) {
        perror("lseek setup");
        return 3;
    }
    if (expect_failure(fd, -1, SEEK_SET, EINVAL) != 0 ||
        expect_failure(fd, -3, SEEK_CUR, EINVAL) != 0 ||
        expect_failure(fd, -7, SEEK_END, EINVAL) != 0) {
        close(fd);
        return 4;
    }

    /*
     * An exact signed off_t above JavaScript's safe-integer boundary is a
     * valid seek, even though a number-only host backend could not represent
     * it. The host-file backend carries it as an exact 64-bit value.
     */
    const off_t large = (off_t)(1ULL << 53);
    errno = 0;
    if (lseek(fd, large, SEEK_SET) != large || errno != 0) {
        fprintf(stderr, "large exact lseek failed: errno=%d (%s)\n",
                errno, strerror(errno));
        close(fd);
        return 4;
    }
    if (lseek(fd, 2, SEEK_SET) != 2 ||
        expect_failure(fd, (off_t)LLONG_MAX, SEEK_CUR, EOVERFLOW) != 0) {
        close(fd);
        return 4;
    }

    char byte = '?';
    if (read(fd, &byte, 1) != 1 || byte != 'c') {
        fprintf(stderr, "offset control read returned %d\n", (unsigned char)byte);
        close(fd);
        return 5;
    }
    close(fd);
    puts("PASS invalid lseek preserves offset");
    return 0;
}
