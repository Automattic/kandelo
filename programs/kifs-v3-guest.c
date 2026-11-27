#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/wait.h>
#include <unistd.h>

static const char directory[] = "/opt/kifs-guest";
static const char file[] = "/opt/kifs-guest/file";
static const char link_path[] = "/opt/kifs-guest/link";
static const char missing[] = "/opt/kifs-guest/missing";
static const char content[] = "KIFS v3 guest fixture\n";
static const char saved[] = "/opt/kifs-guest/saved";
static const char pending[] = "/opt/kifs-guest/pending";
static const char alias[] = "/opt/kifs-guest/alias";
static const char victim[] = "/opt/kifs-guest/victim";
static const char saved_content[] = "KIFS v3 saved data\n";

static int has_content(const char *path, const char *expected, size_t expected_size)
{
    char bytes[64];
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        perror(path);
        return 0;
    }
    ssize_t length = read(fd, bytes, sizeof(bytes));
    return close(fd) == 0 && length == (ssize_t)expected_size
        && memcmp(expected, bytes, expected_size) == 0;
}

static int check_deferred_files(void)
{
    static const char expected[] = "deferred KIFS guest file\n";
    const char *paths[] = { "/opt/deferred/member", "/opt/deferred/file" };
    for (size_t i = 0; i < 2; i++) {
        int fd = open(paths[i], O_RDONLY);
        if (fd < 0) { perror(paths[i]); return 0; }
        void *mapped = mmap(NULL, sizeof(expected) - 1, PROT_READ, MAP_PRIVATE, fd, 0);
        if (mapped == MAP_FAILED) { perror("mmap deferred file"); close(fd); return 0; }
        int matches = memcmp(mapped, expected, sizeof(expected) - 1) == 0;
        if (munmap(mapped, sizeof(expected) - 1) || close(fd) || !matches
            || !has_content(paths[i], expected, sizeof(expected) - 1)) return 0;
    }
    int fd = open("/opt/deferred/rejected", O_RDONLY);
    if (fd < 0) return 0;
    char byte = 'x';
    ssize_t count = read(fd, &byte, 1);
    int error = errno;
    return close(fd) == 0 && count == -1 && error == EIO && byte == 'x';
}

static int has_directory_entries(void)
{
    const char *expected[] = {".", "..", "file", "link"};
    unsigned entries = 0;
    DIR *dir = opendir(directory);
    if (!dir) {
        perror(directory);
        return 0;
    }
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(dir);
        if (!entry) {
            int error = errno;
            return closedir(dir) == 0 && error == 0 && entries == 15;
        }
        unsigned bit = 0;
        for (unsigned index = 0; index < 4; index++) {
            if (strcmp(expected[index], entry->d_name) == 0)
                bit = 1u << index;
        }
        if (bit == 0 || (entries & bit) != 0) {
            closedir(dir);
            return 0;
        }
        entries |= bit;
    }
}

static int is_missing(const char *path)
{
    struct stat st;
    return lstat(path, &st) == -1 && errno == ENOENT;
}

static int same_inode(const char *path, const struct stat *original, nlink_t links)
{
    struct stat st;
    return lstat(path, &st) == 0 && st.st_ino == original->st_ino && st.st_nlink == links;
}

static const char subdir[] = "/opt/kifs-guest/subdir";
static const char soft[] = "/opt/kifs-guest/subdir/soft";
static const struct timespec times[2] = {{123, 456}, {234, 567}};

static int saved_attributes(void)
{
    struct stat st, sym;
    return stat(alias, &st) == 0 && st.st_uid == 31 && st.st_gid == 42
        && (st.st_mode & 07777) == 0750 && st.st_atim.tv_sec == 123
        && st.st_atim.tv_nsec == 456 && st.st_mtim.tv_sec == 234 && st.st_mtim.tv_nsec == 567
        && lstat(soft, &sym) == 0 && S_ISLNK(sym.st_mode) && sym.st_mtim.tv_sec == 345
        && sym.st_mtim.tv_nsec == 678 && sym.st_nlink == 1
        && stat(soft, &sym) == 0 && sym.st_ino == st.st_ino;
}

static int set_saved_attributes(int fd)
{
    const struct timespec link_times[2] = {{0, UTIME_OMIT}, {345, 678}};
    return mkdir(subdir, 0750) == 0 && symlink("../saved", soft) == 0
        && chmod(alias, 06750) == 0 && fchown(fd, 31, 42) == 0
        && utimensat(AT_FDCWD, alias, times, 0) == 0
        && utimensat(AT_FDCWD, soft, link_times, AT_SYMLINK_NOFOLLOW) == 0
        && saved_attributes();
}

static int check_truncate(void)
{
    char bytes[8];
    struct stat st;
    struct statfs before, after;
    int fd = open(pending, O_CREAT | O_RDWR | O_EXCL, 0600);
    if (fd < 0 || write(fd, "abcdefgh", 8) != 8 || pwrite(fd, "x", 1, 65536) != 1
        || statfs(directory, &before) != 0 || ftruncate(fd, 3) != 0
        || statfs(directory, &after) != 0)
        return 0;
    // One data block and its index entry were freed. The metadata total
    // can also cross a block boundary, depending on the starting image.
    if (after.f_bfree < before.f_bfree + 1 || after.f_bfree > before.f_bfree + 2
        || ftruncate(fd, 65537) != 0 || pread(fd, bytes, 8, 0) != 8
        || memcmp(bytes, "abc\0\0\0\0\0", 8) != 0 || pread(fd, bytes, 1, 65536) != 1
        || bytes[0] != 0)
        return 0;
    int trunc = open(pending, O_WRONLY | O_TRUNC);
    return trunc >= 0 && fstat(fd, &st) == 0 && st.st_size == 0
        && close(trunc) == 0 && close(fd) == 0 && unlink(pending) == 0;
}

static int check_directory_handles(void)
{
    const char *old = "/opt/kifs-guest/old-dir";
    const char *moved = "/opt/kifs-guest/moved-dir";
    const char *child = "/opt/kifs-guest/old-dir/child";
    const char *moved_child = "/opt/kifs-guest/moved-dir/child";
    struct stat original, st, original_file, overwritten;
    if (mkdir(old, 0750) || mkdir(child, 0750) || mkdir(moved, 0750))
        return 0;
    int held = open(child, O_DIRECTORY | O_RDONLY);
    int replaced = open(moved, O_DIRECTORY | O_RDONLY);
    int file = openat(held, "original", O_CREAT | O_EXCL | O_RDWR, 0640);
    if (held < 0 || replaced < 0 || file < 0 || fstat(file, &original_file)
        || close(file) || fstat(held, &original) || fstat(replaced, &overwritten)
        || rename(old, moved) || mkdir(old, 0750) || mkdir(child, 0750)
        || stat(child, &st) || st.st_ino == original.st_ino
        || fstat(replaced, &st) || st.st_ino != overwritten.st_ino || st.st_nlink != 0
        || fstat(held, &st) || st.st_ino != original.st_ino
        || fstatat(held, "original", &st, 0) || st.st_ino != original_file.st_ino)
        return 0;
    errno = 0;
    if (openat(replaced, "wrong", O_CREAT | O_EXCL | O_RDWR, 0600) != -1 || errno != ENOENT)
        return 0;
    pid_t child_pid = fork();
    if (child_pid == 0) {
        int fd = openat(held, "original", O_RDONLY);
        _exit(fd >= 0 && fstat(fd, &st) == 0 && st.st_ino == original_file.st_ino ? 0 : 1);
    }
    int status;
    if (child_pid < 0 || waitpid(child_pid, &status, 0) != child_pid || !WIFEXITED(status)
        || WEXITSTATUS(status) != 0)
        return 0;
    DIR *dir = fdopendir(dup(held));
    if (dir == NULL)
        return 0;
    int found = 0;
    struct dirent *ent;
    errno = 0;
    while ((ent = readdir(dir)) != NULL) {
        if (strcmp(ent->d_name, "original") == 0 && ent->d_ino == original_file.st_ino)
            found++;
    }
    if (errno || found != 1 || closedir(dir) || rmdir(moved_child) != -1 || errno != ENOTEMPTY
        || unlinkat(held, "original", 0) || rmdir(moved_child) || fstat(held, &st)
        || st.st_nlink != 0 || st.st_ino != original.st_ino || close(held) || close(replaced)
        || rmdir(child) || rmdir(old) || rmdir(moved))
        return 0;
    return 1;
}

static int save_file(void)
{
    struct stat st, detached;
    int fd = open(pending, O_WRONLY | O_CREAT | O_EXCL, 0640);
    if (fd < 0 || write(fd, saved_content, sizeof(saved_content) - 1) != sizeof(saved_content) - 1
        || fstat(fd, &st) != 0 || link(pending, alias) != 0
        || !same_inode(alias, &st, 2) || rename(pending, alias) != 0
        || !same_inode(pending, &st, 2) || rename(pending, saved) != 0
        || !is_missing(pending) || !same_inode(saved, &st, 2)) {
        perror("link and rename saved file");
        return 1;
    }
    if (link(saved, alias) != -1 || errno != EEXIST || !same_inode(saved, &st, 2)) {
        fputs("duplicate link changed the namespace or returned the wrong error\n", stderr);
        return 1;
    }

    int held = open(victim, O_CREAT | O_RDWR | O_EXCL, 0600);
    char bytes[8];
    struct stat original;
    struct statfs before, after;
    if (held < 0 || write(held, "old data", 8) != 8 || fstat(held, &original) != 0
        || rename(alias, victim) != 0 || !is_missing(alias) || !same_inode(victim, &st, 2)
        || fstat(held, &detached) != 0 || detached.st_ino != original.st_ino
        || detached.st_nlink != 0 || pread(held, bytes, sizeof(bytes), 0) != 8
        || memcmp(bytes, "old data", 8) != 0 || statfs(directory, &before) != 0
        || close(held) != 0 || statfs(directory, &after) != 0 || after.f_bfree <= before.f_bfree) {
        perror("rename over open file and reclaim on close");
        return 1;
    }

    held = open(pending, O_CREAT | O_RDWR | O_EXCL, 0600);
    if (held < 0 || write(held, "unlinked", 8) != 8 || unlink(pending) != 0
        || !is_missing(pending) || fstat(held, &detached) != 0 || detached.st_nlink != 0
        || pread(held, bytes, sizeof(bytes), 0) != 8 || memcmp(bytes, "unlinked", 8) != 0
        || fchmod(held, 0620) != 0 || futimens(held, times) != 0 || fstat(held, &detached) != 0
        || (detached.st_mode & 07777) != 0620 || detached.st_mtim.tv_sec != 234 || detached.st_mtim.tv_nsec != 567
        || close(held) != 0 || unlink(victim) != 0 || !same_inode(saved, &st, 1)
        || link(saved, alias) != 0) {
        perror("unlink open file and persist remaining hard links");
        return 1;
    }
    if (!set_saved_attributes(fd)) {
        perror("set saved attributes");
        return 1;
    }
    if (!check_truncate()) {
        perror("truncate sparse file");
        return 1;
    }
    int dirfd = open(directory, O_RDONLY | O_DIRECTORY);
    if (dirfd < 0 || fsync(dirfd) != 0 || close(dirfd) != 0) {
        perror("sync saved directory");
        return 1;
    }
    if (fsync(fd) != 0 || close(fd) != 0) {
        perror("sync saved file");
        return 1;
    }
    if (!check_directory_handles()) {
        perror("directory descriptor after rename, replacement or removal");
        return 1;
    }
    puts("KIFS v3 guest directory descriptors passed");
    printf("KIFS v3 guest persisted inode %" PRIuMAX "\n", (uintmax_t)st.st_ino);
    return 0;
}

static int verify_saved_file(const char *expected_inode)
{
    struct stat st;
    if (!saved_attributes() || stat(saved, &st) != 0 || !same_inode(alias, &st, 2) || st.st_nlink != 2
        || !is_missing(pending) || !is_missing(victim) || !has_content(saved, saved_content, sizeof(saved_content) - 1)) {
        fputs("saved file lookup or read failed after reboot\n", stderr);
        return 1;
    }
    char inode[32];
    snprintf(inode, sizeof(inode), "%" PRIuMAX, (uintmax_t)st.st_ino);
    if (strcmp(inode, expected_inode) != 0) {
        fprintf(stderr, "saved inode changed from %s to %s\n", expected_inode, inode);
        return 1;
    }
    printf("KIFS v3 guest verified attributes of linked inode %s\n", inode);
    return 0;
}

int main(int argc, char **argv)
{
    struct stat st;
    struct statfs volume;
    if (statfs(directory, &volume) != 0 || volume.f_type != 0x5346494b) {
        fputs("expected a KIFS mount\n", stderr);
        return 1;
    }
    if (!check_deferred_files()) {
        fputs("deferred file mapping, verified read or integrity rejection failed\n", stderr);
        return 1;
    }
    if (argc == 3 && strcmp(argv[1], "verify") == 0)
        return verify_saved_file(argv[2]);
    if (stat(file, &st) != 0 || !S_ISREG(st.st_mode) || !has_content(file, content, sizeof(content) - 1)) {
        fputs("regular file lookup or read failed\n", stderr);
        return 1;
    }
    if (!has_directory_entries()) {
        fputs("directory enumeration failed\n", stderr);
        return 1;
    }
    char target[8];
    if (lstat(link_path, &st) != 0 || !S_ISLNK(st.st_mode)
        || readlink(link_path, target, sizeof(target)) != 4
        || memcmp(target, "file", 4) != 0 || !has_content(link_path, content, sizeof(content) - 1)) {
        fputs("symlink lookup or read failed\n", stderr);
        return 1;
    }
    errno = 0;
    if (stat(missing, &st) != -1 || errno != ENOENT) {
        fputs("missing path did not return ENOENT\n", stderr);
        return 1;
    }
    puts("KIFS v3 guest read passed");
    if (argc == 2 && strcmp(argv[1], "create") == 0)
        return save_file();
    return 0;
}
