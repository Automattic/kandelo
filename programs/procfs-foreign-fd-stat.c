#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static int same_file(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev &&
           left->st_ino == right->st_ino &&
           (left->st_mode & S_IFMT) == (right->st_mode & S_IFMT) &&
           left->st_size == right->st_size;
}

int main(void) {
    static const char payload[] = "foreign-open-file";
    char target[] = "/tmp/procfs-fd-stat-XXXXXX";
    char proc_path[64];
    int ready[2];
    int release[2];
    struct stat expected;
    struct stat followed;
    struct stat followed_at;
    struct stat link;

    int target_fd = mkstemp(target);
    if (target_fd < 0) {
        perror("mkstemp");
        return 1;
    }
    if (write(target_fd, payload, sizeof(payload) - 1) != (ssize_t)(sizeof(payload) - 1) ||
        fstat(target_fd, &expected) != 0) {
        perror("prepare target");
        close(target_fd);
        unlink(target);
        return 2;
    }
    if (pipe(ready) != 0 || pipe(release) != 0) {
        perror("pipe");
        close(target_fd);
        unlink(target);
        return 3;
    }

    pid_t holder = fork();
    if (holder < 0) {
        perror("fork");
        close(target_fd);
        unlink(target);
        return 4;
    }
    if (holder == 0) {
        char byte = 'R';
        close(ready[0]);
        close(release[1]);
        if (write(ready[1], &byte, 1) != 1 || read(release[0], &byte, 1) != 1) {
            _exit(10);
        }
        close(target_fd);
        _exit(0);
    }

    close(ready[1]);
    close(release[0]);
    close(target_fd);
    if (unlink(target) != 0) {
        perror("unlink");
        kill(holder, SIGKILL);
        waitpid(holder, NULL, 0);
        return 5;
    }

    char byte;
    if (read(ready[0], &byte, 1) != 1) {
        perror("holder ready");
        kill(holder, SIGKILL);
        waitpid(holder, NULL, 0);
        return 6;
    }
    snprintf(proc_path, sizeof(proc_path), "/proc/%ld/fd/%d", (long)holder, target_fd);

    int rc = 0;
    if (stat(proc_path, &followed) != 0) {
        perror("stat proc fd");
        rc = 7;
    } else if (!same_file(&expected, &followed)) {
        fprintf(stderr, "stat proc fd returned different OFD metadata\n");
        rc = 8;
    }
    if (rc == 0 && fstatat(AT_FDCWD, proc_path, &followed_at, 0) != 0) {
        perror("fstatat proc fd");
        rc = 9;
    } else if (rc == 0 && !same_file(&expected, &followed_at)) {
        fprintf(stderr, "fstatat proc fd returned different OFD metadata\n");
        rc = 10;
    }
    if (rc == 0 && lstat(proc_path, &link) != 0) {
        perror("lstat proc fd");
        rc = 11;
    } else if (rc == 0 && !S_ISLNK(link.st_mode)) {
        fprintf(stderr, "lstat proc fd did not preserve the procfs symlink\n");
        rc = 12;
    }

    byte = 'X';
    if (write(release[1], &byte, 1) != 1 && rc == 0) {
        perror("release holder");
        rc = 13;
    }
    int status = 0;
    if (waitpid(holder, &status, 0) != holder || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "holder did not exit cleanly\n");
        if (rc == 0) rc = 14;
    }
    if (rc != 0) return rc;

    puts("procfs-foreign-fd-stat-ok");
    return 0;
}
