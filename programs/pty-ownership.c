#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static void fail(const char *what)
{
    fprintf(stderr, "PTY_OWNERSHIP_FAIL: %s: %s\n", what, strerror(errno));
    exit(1);
}

static void check(int condition, const char *what)
{
    if (!condition) {
        errno = EINVAL;
        fail(what);
    }
}

static void become(uid_t uid, gid_t gid, const gid_t *groups, size_t count)
{
    if (seteuid(0) != 0) fail("restore root euid");
    if (setegid(0) != 0) fail("restore root egid");
    if (setgroups(count, groups) != 0) fail("replace supplementary groups");
    if (setegid(gid) != 0) fail("select effective gid");
    if (seteuid(uid) != 0) fail("select effective uid");
}

static struct stat path_stat(const char *path)
{
    struct stat st;
    if (stat(path, &st) != 0) fail("stat PTY path");
    return st;
}

static struct stat fd_stat(int fd)
{
    struct stat st;
    if (fstat(fd, &st) != 0) fail("fstat PTY fd");
    return st;
}

static void expect_metadata(
    const struct stat *st,
    mode_t mode,
    uid_t uid,
    gid_t gid,
    const char *what)
{
    if (!S_ISCHR(st->st_mode) || (st->st_mode & 07777) != mode ||
        st->st_uid != uid || st->st_gid != gid) {
        fprintf(stderr,
            "PTY_OWNERSHIP_FAIL: %s: mode=%04o uid=%u gid=%u\n",
            what, (unsigned)(st->st_mode & 07777), (unsigned)st->st_uid,
            (unsigned)st->st_gid);
        exit(1);
    }
}

static void expect_same_slave(const struct stat *left,
                              const struct stat *right,
                              const char *what)
{
    check(left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
          left->st_mode == right->st_mode && left->st_uid == right->st_uid &&
          left->st_gid == right->st_gid, what);
}

static void expect_path_stat_variants(const char *path,
                                      const struct stat *expected,
                                      const char *what)
{
    struct stat at_stat;
    if (fstatat(AT_FDCWD, path, &at_stat, 0) != 0) fail(what);
    expect_same_slave(&at_stat, expected, what);

    struct statx stx;
    if (statx(AT_FDCWD, path, 0, STATX_BASIC_STATS, &stx) != 0) fail(what);
    check((stx.stx_mode & S_IFMT) == S_IFCHR &&
          (stx.stx_mode & 07777) == (expected->st_mode & 07777) &&
          stx.stx_ino == expected->st_ino &&
          stx.stx_uid == expected->st_uid && stx.stx_gid == expected->st_gid,
          what);
}

static void expect_open_error(const char *path, int flags, int error,
                              const char *what)
{
    errno = 0;
    int fd = open(path, flags | O_NOCTTY | O_NONBLOCK);
    if (fd >= 0) close(fd);
    check(fd == -1 && errno == error, what);
}

static int open_slave(const char *path, int flags, const char *what)
{
    int fd = open(path, flags | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) fail(what);
    return fd;
}

int main(void)
{
    char slave_path[64];
    char fresh_path[64];
    gid_t owner_groups[] = { 3000, 4000 };
    gid_t supplementary_group[] = { 2000 };

    check(getuid() == 0 && geteuid() == 0, "probe must start as root");
    become(1000, 2000, NULL, 0);

    int master = posix_openpt(O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (master < 0) fail("posix_openpt");
    if (grantpt(master) != 0) fail("grantpt");
    if (unlockpt(master) != 0) fail("unlockpt");
    if (ptsname_r(master, slave_path, sizeof(slave_path)) != 0)
        fail("ptsname_r");

    struct stat slave_initial = path_stat(slave_path);
    expect_metadata(&slave_initial, 0620, 1000, 2000,
                    "creator metadata and configured effective gid");

    struct stat master_path = path_stat("/dev/ptmx");
    struct stat master_fd = fd_stat(master);
    expect_same_slave(&master_path, &master_fd,
                      "master fd must retain /dev/ptmx metadata");
    expect_metadata(&master_fd, 0620, 0, 0,
                    "master must not alias devpts slave ownership");
    check(master_fd.st_ino != slave_initial.st_ino,
          "master and slave must have distinct inode identities");

    int slave = open_slave(slave_path, O_RDWR, "owner open");
    struct stat slave_fd = fd_stat(slave);
    expect_same_slave(&slave_initial, &slave_fd,
                      "initial path and fd metadata");
    expect_path_stat_variants(slave_path, &slave_initial,
                              "initial fstatat/statx metadata");

    become(9000, 9000, NULL, 0);
    errno = 0;
    check(chmod(slave_path, 0600) == -1 && errno == EPERM,
          "unrelated chmod denial");
    errno = 0;
    check(fchmod(slave, 0600) == -1 && errno == EPERM,
          "unrelated fchmod denial");
    errno = 0;
    check(chown(slave_path, (uid_t)-1, 9000) == -1 && errno == EPERM,
          "unrelated chown denial");
    errno = 0;
    check(lchown(slave_path, (uid_t)-1, 9000) == -1 && errno == EPERM,
          "unrelated lchown denial");
    errno = 0;
    check(fchown(slave, (uid_t)-1, 9000) == -1 && errno == EPERM,
          "unrelated fchown denial");
    struct stat rejected = path_stat(slave_path);
    expect_same_slave(&rejected, &slave_initial,
                      "failed mutations must not change state");

    become(1000, 2000, owner_groups, 2);
    if (chmod(slave_path, 0640) != 0) fail("owner chmod");
    if (fchmod(slave, 0600) != 0) fail("owner fchmod");
    if (chown(slave_path, (uid_t)-1, 3000) != 0)
        fail("owner chown supplementary group");
    if (lchown(slave_path, (uid_t)-1, 4000) != 0)
        fail("owner lchown supplementary group");
    if (fchown(slave, (uid_t)-1, 2000) != 0)
        fail("owner fchown effective group");
    struct stat owner_updated = path_stat(slave_path);
    expect_metadata(&owner_updated, 0600, 1000, 2000,
                    "owner mutation round trip");
    slave_fd = fd_stat(slave);
    expect_same_slave(&owner_updated, &slave_fd,
                      "owner path and fd metadata");

    errno = 0;
    check(fchown(slave, 1001, (gid_t)-1) == -1 && errno == EPERM,
          "owner cannot give PTY away");
    rejected = fd_stat(slave);
    expect_same_slave(&rejected, &owner_updated,
                      "failed owner fchown must be atomic");

    become(0, 0, NULL, 0);
    if (chown(slave_path, 1100, 2100) != 0) fail("root chown");
    if (fchmod(slave, 0660) != 0) fail("root fchmod");
    if (fchown(slave, 1200, 2200) != 0) fail("root fchown");
    if (lchown(slave_path, 1300, 2300) != 0) fail("root lchown");
    struct stat root_updated = path_stat(slave_path);
    expect_metadata(&root_updated, 0660, 1300, 2300,
                    "root mutation round trip");
    slave_fd = fd_stat(slave);
    expect_same_slave(&root_updated, &slave_fd,
                      "root path and fd metadata");
    expect_path_stat_variants(slave_path, &root_updated,
                              "mutated fstatat/statx metadata");

    struct stat tty_path = path_stat("/dev/tty");
    int tty = open_slave("/dev/tty", O_RDWR, "open controlling alias");
    struct stat tty_fd = fd_stat(tty);
    expect_same_slave(&tty_path, &tty_fd,
                      "control alias path and fd metadata");
    check(tty_fd.st_ino != root_updated.st_ino,
          "control alias must not use slave inode identity");
    if (fchmod(tty, 0777) != 0) fail("control alias fchmod compatibility");
    if (fchown(tty, 77, 88) != 0) fail("control alias fchown compatibility");
    tty_fd = fd_stat(tty);
    expect_same_slave(&tty_path, &tty_fd,
                      "control alias metadata remains stable");
    struct stat after_tty_mutation = path_stat(slave_path);
    expect_same_slave(&after_tty_mutation, &root_updated,
                      "control alias calls must not mutate slave metadata");
    if (close(tty) != 0) fail("close controlling alias");

    if (fchmod(master, 0777) != 0) fail("master fchmod compatibility");
    if (fchown(master, 77, 88) != 0) fail("master fchown compatibility");
    struct stat after_master_mutation = path_stat(slave_path);
    expect_same_slave(&after_master_mutation, &root_updated,
                      "master calls must not mutate slave metadata");

    if (fchown(slave, 1000, 2000) != 0) fail("restore slave ownership");
    if (fchmod(slave, 0620) != 0) fail("restore slave mode");

    become(1000, 2000, NULL, 0);
    int probe = open_slave(slave_path, O_RDWR, "owner read/write open");
    close(probe);

    become(3000, 2000, NULL, 0);
    probe = open_slave(slave_path, O_WRONLY, "effective group write open");
    close(probe);
    expect_open_error(slave_path, O_RDONLY, EACCES,
                      "effective group read denial");

    become(3000, 4000, supplementary_group, 1);
    probe = open_slave(slave_path, O_WRONLY,
                       "supplementary group write open");
    close(probe);

    become(3000, 4000, NULL, 0);
    expect_open_error(slave_path, O_WRONLY, EACCES,
                      "unrelated user write denial");
    expect_open_error(slave_path, O_RDONLY, EACCES,
                      "unrelated user read denial");

    become(0, 0, NULL, 0);
    probe = open_slave(slave_path, O_RDWR, "root read/write open");
    close(probe);

    become(1000, 2000, NULL, 0);
    if (chmod(slave_path, 0640) != 0) fail("owner group-read chmod");
    become(3000, 2000, NULL, 0);
    probe = open_slave(slave_path, O_RDONLY, "effective group read open");
    close(probe);
    expect_open_error(slave_path, O_WRONLY, EACCES,
                      "effective group write denial after chmod");
    become(3000, 4000, supplementary_group, 1);
    probe = open_slave(slave_path, O_RDONLY,
                       "supplementary group read open");
    close(probe);

    become(1000, 2000, NULL, 0);
    if (fchmod(slave, 0600) != 0) fail("persistent close mode");
    if (close(slave) != 0) fail("close original slave");
    struct stat while_closed = path_stat(slave_path);
    expect_metadata(&while_closed, 0600, 1000, 2000,
                    "metadata survives last slave close");
    slave = open_slave(slave_path, O_RDWR, "owner reopen");
    slave_fd = fd_stat(slave);
    expect_same_slave(&while_closed, &slave_fd,
                      "metadata survives slave reopen");
    if (close(slave) != 0) fail("close reopened slave");
    if (close(master) != 0) fail("close master");

    errno = 0;
    check(stat(slave_path, &slave_initial) == -1 && errno == ENOENT,
          "pair destruction removes slave metadata");

    become(3000, 4000, NULL, 0);
    master = posix_openpt(O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (master < 0) fail("reallocate PTY");
    if (unlockpt(master) != 0) fail("unlock reallocated PTY");
    if (ptsname_r(master, fresh_path, sizeof(fresh_path)) != 0)
        fail("fresh ptsname_r");
    check(strcmp(fresh_path, slave_path) == 0,
          "destroyed pair slot must be reusable");
    struct stat fresh = path_stat(fresh_path);
    expect_metadata(&fresh, 0620, 3000, 4000,
                    "reused pair receives fresh metadata");
    if (close(master) != 0) fail("close reallocated master");

    puts("PTY_OWNERSHIP_PASS");
    return 0;
}
