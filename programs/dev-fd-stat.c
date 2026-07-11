#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

static int same_file_identity(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev &&
           left->st_ino == right->st_ino &&
           left->st_mode == right->st_mode;
}

static int check_fd_alias(const char *path, int fd) {
    struct stat fd_stat;
    struct stat path_stat;
    struct stat at_stat;
    struct stat link_stat;
    struct stat nofollow_stat;
    char link_target[128];

    if (fstat(fd, &fd_stat) != 0) {
        perror("fstat");
        return 1;
    }
    if (stat(path, &path_stat) != 0) {
        perror(path);
        return 1;
    }
    if (!same_file_identity(&path_stat, &fd_stat)) {
        fprintf(stderr,
                "%s stat mismatch: path=(%llu,%llu,%o) fd=(%llu,%llu,%o)\n",
                path,
                (unsigned long long)path_stat.st_dev,
                (unsigned long long)path_stat.st_ino,
                path_stat.st_mode,
                (unsigned long long)fd_stat.st_dev,
                (unsigned long long)fd_stat.st_ino,
                fd_stat.st_mode);
        return 1;
    }
    if (fstatat(AT_FDCWD, path, &at_stat, 0) != 0) {
        perror("fstatat");
        return 1;
    }
    if (!same_file_identity(&at_stat, &fd_stat)) {
        fprintf(stderr, "%s fstatat did not follow the descriptor alias\n", path);
        return 1;
    }
    if (lstat(path, &link_stat) != 0) {
        perror("lstat");
        return 1;
    }
    if (!S_ISLNK(link_stat.st_mode)) {
        fprintf(stderr, "%s lstat mode is %o, expected a symlink\n", path,
                link_stat.st_mode);
        return 1;
    }
    if (fstatat(AT_FDCWD, path, &nofollow_stat, AT_SYMLINK_NOFOLLOW) != 0) {
        perror("fstatat nofollow");
        return 1;
    }
    if (!S_ISLNK(nofollow_stat.st_mode) ||
        nofollow_stat.st_ino != link_stat.st_ino) {
        fprintf(stderr, "%s fstatat nofollow did not report the symlink\n", path);
        return 1;
    }
    ssize_t link_len = readlink(path, link_target, sizeof(link_target));
    if (link_len <= 0 || link_stat.st_size != link_len) {
        fprintf(stderr, "%s readlink disagrees with lstat size\n", path);
        return 1;
    }
    return 0;
}

int main(void) {
    if (check_fd_alias("/dev/stdin", STDIN_FILENO) != 0 ||
        check_fd_alias("/dev/stdout", STDOUT_FILENO) != 0 ||
        check_fd_alias("/dev/stderr", STDERR_FILENO) != 0) {
        return 1;
    }

    int null_fd = open("/dev/null", O_RDWR);
    if (null_fd < 0) {
        perror("open /dev/null");
        return 1;
    }

    char fd_path[32];
    snprintf(fd_path, sizeof(fd_path), "/dev/fd/%d", null_fd);
    int result = check_fd_alias(fd_path, null_fd);
    close(null_fd);
    if (result != 0) {
        return result;
    }

    puts("PASS");
    return 0;
}
