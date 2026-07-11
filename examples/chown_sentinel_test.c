#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

static int expect_ids(int fd, uid_t uid, gid_t gid, const char *step)
{
    struct stat st;
    if (fstat(fd, &st) != 0) {
        perror("fstat");
        return -1;
    }
    if (st.st_uid != uid || st.st_gid != gid) {
        fprintf(stderr, "%s: got uid=%u gid=%u, expected uid=%u gid=%u\n",
            step, (unsigned)st.st_uid, (unsigned)st.st_gid,
            (unsigned)uid, (unsigned)gid);
        return -1;
    }
    return 0;
}

int main(void)
{
    const char *path = "/tmp/chown-sentinel";
    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) {
        perror("open");
        return 1;
    }

    if (fchown(fd, 101, 202) != 0 || expect_ids(fd, 101, 202, "initial") != 0)
        return 2;
    if (fchown(fd, (uid_t)-1, 303) != 0 ||
        expect_ids(fd, 101, 303, "fchown uid sentinel") != 0)
        return 3;
    if (fchown(fd, 404, (gid_t)-1) != 0 ||
        expect_ids(fd, 404, 303, "fchown gid sentinel") != 0)
        return 4;
    if (chown(path, (uid_t)-1, 505) != 0 ||
        expect_ids(fd, 404, 505, "chown uid sentinel") != 0)
        return 5;
    if (fchownat(AT_FDCWD, path, 606, (gid_t)-1, 0) != 0 ||
        expect_ids(fd, 606, 505, "fchownat gid sentinel") != 0)
        return 6;
    if (chown(path, (uid_t)-1, (gid_t)-1) != 0 ||
        expect_ids(fd, 606, 505, "both sentinels") != 0)
        return 7;
    if (fchown(fd, 606, 505) != 0 ||
        expect_ids(fd, 606, 505, "explicit same ids") != 0)
        return 8;

    errno = 0;
    if (chown("/tmp/chown-sentinel-missing", (uid_t)-1, (gid_t)-1) != -1 ||
        errno != ENOENT) {
        fprintf(stderr, "missing target did not return ENOENT: rc/errno=%d\n", errno);
        return 9;
    }
    errno = 0;
    if (fchown(9999, (uid_t)-1, (gid_t)-1) != -1 || errno != EBADF) {
        fprintf(stderr, "invalid fd did not return EBADF: errno=%d\n", errno);
        return 10;
    }

    if (chown(path, 999, 505) != 0 || seteuid(999) != 0)
        return 11;
    if (chown(path, (uid_t)-1, (gid_t)-1) != 0)
        return 12;
    if (seteuid(0) != 0 || seteuid(777) != 0)
        return 13;
    errno = 0;
    if (chown(path, 999, 505) != -1 || errno != EPERM)
        return 14;
    errno = 0;
    if (chown(path, (uid_t)-1, 505) != -1 || errno != EPERM)
        return 15;
    if (seteuid(0) != 0)
        return 16;

    close(fd);
    puts("CHOWN_SENTINEL_PASS");
    return 0;
}
