#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int same_file(const struct stat *left, const struct stat *right)
{
    return left->st_dev == right->st_dev &&
        left->st_ino == right->st_ino &&
        left->st_mode == right->st_mode &&
        left->st_size == right->st_size;
}

static int expect_errno(int rc, int expected, const char *step)
{
    if (rc == -1 && errno == expected)
        return 0;
    fprintf(stderr, "%s: rc=%d errno=%d (%s), expected %d\n",
        step, rc, errno, strerror(errno), expected);
    return -1;
}

int main(void)
{
    const char *dir = "/tmp/fstatat-empty-path";
    const char *file = "/tmp/fstatat-empty-path/file";
    struct stat expected;
    struct stat actual;

    if (mkdir(dir, 0755) != 0 && errno != EEXIST) {
        perror("mkdir");
        return 1;
    }
    int fd = open(file, O_CREAT | O_RDWR | O_TRUNC, 0640);
    if (fd < 0 || write(fd, "data", 4) != 4) {
        perror("open/write");
        return 2;
    }

    if (fstat(fd, &expected) != 0 ||
        fstatat(fd, "", &actual, AT_EMPTY_PATH) != 0 ||
        !same_file(&expected, &actual)) {
        perror("fstatat fd empty path");
        return 3;
    }

    if (chdir(dir) != 0 || stat(".", &expected) != 0 ||
        fstatat(AT_FDCWD, "", &actual, AT_EMPTY_PATH) != 0 ||
        !same_file(&expected, &actual) || !S_ISDIR(actual.st_mode)) {
        perror("fstatat cwd empty path");
        return 4;
    }

    errno = 0;
    if (expect_errno(fstatat(fd, "", &actual, 0), ENOENT,
            "empty path without AT_EMPTY_PATH on fd") != 0)
        return 5;
    errno = 0;
    if (expect_errno(fstatat(AT_FDCWD, "", &actual, 0), ENOENT,
            "empty path without AT_EMPTY_PATH on cwd") != 0)
        return 6;
    errno = 0;
    if (expect_errno(fstatat(9999, "", &actual, AT_EMPTY_PATH), EBADF,
            "empty path on invalid fd") != 0)
        return 7;
    errno = 0;
    if (expect_errno(fstatat(fd, "", &actual, AT_EMPTY_PATH | 0x400), EINVAL,
            "empty path with invalid flags") != 0)
        return 8;

    close(fd);
    puts("FSTATAT_EMPTY_PATH_PASS");
    return 0;
}
