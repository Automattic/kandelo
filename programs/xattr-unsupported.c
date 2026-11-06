/* Extended attributes on a filesystem that does not support them.
 *
 * Only the exchange filesystem stores extended attributes; /tmp does not.
 * The calls must say so truthfully, the way Linux does for a filesystem without xattr handlers:
 * get, set, and remove fail with ENOTSUP; list succeeds with an empty list.
 * Path and descriptor errors come first, and setxattr validates its flags,
 * name, and size before the path. Prints PASS and exits 0 only if every
 * check holds. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/xattr.h>
#include <unistd.h>

static int failures;
static char big[70000];

static void expect_errno(const char *what, long result, int expected) {
    if (result != -1 || errno != expected) {
        fprintf(stderr, "%s: got result %ld errno %d (%s), want -1 errno %d (%s)\n",
                what, result, errno, strerror(errno), expected, strerror(expected));
        failures++;
    }
}

static void expect_value(const char *what, long result, long expected) {
    if (result != expected) {
        fprintf(stderr, "%s: got %ld (errno %d), want %ld\n", what, result, errno, expected);
        failures++;
    }
}

int main(void) {
    const char *file = "/tmp/xattr-file";
    const char *dangling = "/tmp/xattr-dangling";
    char buffer[64];
    char long_name[300];

    int fd = open(file, O_RDWR | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        perror("open");
        return 1;
    }
    unlink(dangling);
    if (symlink("/tmp/xattr-nowhere", dangling) != 0) {
        perror("symlink");
        return 1;
    }

    expect_errno("setxattr", setxattr(file, "user.a", "v", 1, 0), ENOTSUP);
    expect_errno("lsetxattr", lsetxattr(file, "user.a", "v", 1, XATTR_CREATE), ENOTSUP);
    expect_errno("fsetxattr", fsetxattr(fd, "user.a", "v", 1, XATTR_REPLACE), ENOTSUP);
    expect_errno("getxattr", getxattr(file, "user.a", buffer, sizeof buffer), ENOTSUP);
    expect_errno("getxattr size query", getxattr(file, "user.a", NULL, 0), ENOTSUP);
    expect_errno("fgetxattr", fgetxattr(fd, "user.a", buffer, sizeof buffer), ENOTSUP);
    expect_errno("removexattr", removexattr(file, "user.a"), ENOTSUP);
    expect_errno("fremovexattr", fremovexattr(fd, "user.a"), ENOTSUP);

    expect_value("listxattr", listxattr(file, buffer, sizeof buffer), 0);
    expect_value("listxattr size query", listxattr(file, NULL, 0), 0);
    expect_value("flistxattr", flistxattr(fd, buffer, sizeof buffer), 0);
    expect_value("llistxattr on a dangling symlink", llistxattr(dangling, buffer, sizeof buffer), 0);

    expect_errno("getxattr missing path", getxattr("/tmp/xattr-missing", "user.a", buffer, sizeof buffer), ENOENT);
    expect_errno("listxattr missing path", listxattr("/tmp/xattr-missing", buffer, sizeof buffer), ENOENT);
    expect_errno("getxattr through a dangling symlink", getxattr(dangling, "user.a", buffer, sizeof buffer), ENOENT);
    expect_errno("lgetxattr on a dangling symlink", lgetxattr(dangling, "user.a", buffer, sizeof buffer), ENOTSUP);
    expect_errno("fgetxattr closed fd", fgetxattr(-1, "user.a", buffer, sizeof buffer), EBADF);

    expect_errno("setxattr bad flags", setxattr("/tmp/xattr-missing", "user.a", "v", 1, 4), EINVAL);
    expect_errno("getxattr empty name", getxattr(file, "", buffer, sizeof buffer), ERANGE);
    memset(long_name, 'a', sizeof long_name - 1);
    long_name[sizeof long_name - 1] = '\0';
    expect_errno("getxattr long name", getxattr(file, long_name, buffer, sizeof buffer), ERANGE);

    /* Linux XATTR_SIZE_MAX is 64 KiB: a larger value is E2BIG, while a larger
     * get or list buffer is simply clamped. */
    expect_errno("setxattr oversized value", setxattr(file, "user.a", big, 65537, 0), E2BIG);
    expect_errno("setxattr largest value", setxattr(file, "user.a", big, 65536, 0), ENOTSUP);
    expect_errno("getxattr oversized buffer", getxattr(file, "user.a", big, sizeof big), ENOTSUP);
    expect_value("listxattr oversized buffer", listxattr(file, big, sizeof big), 0);

    close(fd);
    unlink(dangling);
    unlink(file);

    if (failures != 0) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("PASS\n");
    return 0;
}
