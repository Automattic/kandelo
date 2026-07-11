#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
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

static int expect_path_ids(const char *path, int follow, uid_t uid, gid_t gid,
    const char *step)
{
    struct stat st;
    int rc = follow ? stat(path, &st) : lstat(path, &st);
    if (rc != 0) {
        perror(step);
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
    if (futimens(fd, NULL) != 0) {
        perror("futimens null pathname");
        return 33;
    }

    const char *target = "/dev/shm/lchown-target";
    const char *link = "/tmp/lchown-link";
    const char *dangling = "/tmp/lchown-dangling";
    unlink(link);
    unlink(dangling);
    unlink(target);
    int target_fd = open(target, O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (target_fd < 0 || fchown(target_fd, 111, 222) != 0)
        return 17;
    if (symlink(target, link) != 0 || lchown(link, 333, 444) != 0)
        return 18;
    if (expect_path_ids(link, 0, 333, 444, "lchown link") != 0 ||
        expect_path_ids(link, 1, 111, 222, "lchown target") != 0)
        return 19;

    if (chown(link, 555, 666) != 0 ||
        expect_path_ids(link, 0, 333, 444, "chown preserves link") != 0 ||
        expect_path_ids(link, 1, 555, 666, "chown follows link") != 0)
        return 20;
    if (fchownat(AT_FDCWD, link, 777, 888, AT_SYMLINK_NOFOLLOW) != 0 ||
        expect_path_ids(link, 0, 777, 888, "fchownat nofollow link") != 0 ||
        expect_path_ids(link, 1, 555, 666, "fchownat preserves target") != 0)
        return 21;
    if (lchown(link, (uid_t)-1, 889) != 0 ||
        expect_path_ids(link, 0, 777, 889, "lchown uid sentinel") != 0)
        return 22;

    if (symlink("/tmp/lchown-missing", dangling) != 0 ||
        lchown(dangling, 901, 902) != 0 ||
        expect_path_ids(dangling, 0, 901, 902, "dangling lchown") != 0)
        return 23;
    errno = 0;
    if (chown(dangling, 1, 2) != -1 || errno != ENOENT)
        return 24;

    if (mkdir("/tmp/lchown-dir", 0755) != 0 && errno != EEXIST)
        return 25;
    int dirfd = open("/tmp/lchown-dir", O_RDONLY | O_DIRECTORY);
    if (dirfd < 0)
        return 26;
    unlink("/tmp/lchown-dir/relative-link");
    if (symlink(target, "/tmp/lchown-dir/relative-link") != 0 ||
        fchownat(dirfd, "relative-link", 903, 904, AT_SYMLINK_NOFOLLOW) != 0 ||
        expect_path_ids("/tmp/lchown-dir/relative-link", 0, 903, 904,
            "relative fchownat nofollow") != 0 ||
        expect_path_ids(target, 1, 555, 666, "relative preserves target") != 0)
        return 27;
    close(dirfd);

    errno = 0;
    if (fchownat(AT_FDCWD, link, 1, 2, 0x200) != -1 || errno != EINVAL)
        return 28;
    errno = 0;
    if (syscall(SYS_lchown, (const char *)0, 1, 2) != -1 || errno != EFAULT)
        return 29;
    errno = 0;
    if (syscall(SYS_lchown, (const char *)(uintptr_t)-1, 1, 2) != -1 ||
        errno != EFAULT)
        return 30;
    char *unterminated = malloc(65536);
    if (unterminated == NULL)
        return 31;
    memset(unterminated, 'x', 65536);
    errno = 0;
    if (syscall(SYS_lchown, unterminated, 1, 2) != -1 ||
        errno != ENAMETOOLONG) {
        free(unterminated);
        return 32;
    }
    free(unterminated);
    close(target_fd);

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
