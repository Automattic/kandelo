#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <time.h>
#include <unistd.h>

/* Exercise a disposable volume supplied by the harness through guest syscalls.
 * The caller chooses the parent. O_EXCL prevents collisions with existing data. */
static void require(int ok, const char *operation)
{
    if (!ok) {
        fprintf(stderr, "%s failed (errno %d)\n", operation, errno);
        exit(1);
    }
}

static struct statfs usage(void)
{
    struct statfs result;
    require(statfs(".", &result) == 0, "statfs");
    return result;
}

static void name(char *buffer, unsigned number)
{
    snprintf(buffer, 32, "entry-%08u", number);
}

static int create(const char *path)
{
    return open(path, O_CREAT | O_WRONLY | O_EXCL, 0600);
}

static void require_absent(const char *path)
{
    struct stat st;
    require(lstat(path, &st) == -1 && errno == ENOENT, "failed create left a name");
}

static void fill_small_volume(void)
{
    struct statfs initial = usage();
    require(initial.f_blocks <= 1024, "expected small test volume");
    char block[4096];
    memset(block, 'x', sizeof(block));
    int fd = create("data");
    require(fd >= 0, "create data file");
    size_t blocks = 0;
    ssize_t written;
    while ((written = write(fd, block, sizeof(block))) == sizeof(block)) {
        require(++blocks <= initial.f_blocks, "data exceeds logical budget");
    }
    require(blocks > 0 && written == -1 && errno == ENOSPC, "data exhaustion");
    struct stat st;
    require(fstat(fd, &st) == 0 && st.st_size == (off_t)(blocks * sizeof(block)), "failed write changed size");
    require(close(fd) == 0, "close data");
    // Use any slack in the final logical metadata block.
    unsigned entries = 0;
    char path[32];
    for (;;) {
        name(path, entries);
        int entry = create(path);
        if (entry < 0) break;
        require(close(entry) == 0 && ++entries <= 4096, "unbounded metadata");
    }
    require(errno == ENOSPC, "metadata exhaustion");
    require_absent(path);
    struct statfs full = usage();
    require(full.f_bavail == 0, "full volume still reports available blocks");
    require(unlink("data") == 0, "release data and metadata");
    require(usage().f_bfree >= full.f_bfree + blocks, "reclaim data blocks");
    fd = create(path);
    require(fd >= 0 && write(fd, block, sizeof(block)) == sizeof(block) && close(fd) == 0, "reuse failed name");
    for (unsigned i = 0; i <= entries; i++) {
        name(path, i);
        require(unlink(path) == 0, "reclaim names");
    }
    require(usage().f_bfree == initial.f_bfree, "restore logical free space");
    printf("capacity exhaustion passed blocks=%zu residual_entries=%u\n", blocks, entries);
}

static void many_files(unsigned count)
{
    struct statfs before = usage();
    char path[32];
    // Descending names exercise repeated insertions at the start of a leaf.
    for (unsigned remaining = count; remaining > 0; --remaining) {
        unsigned i = remaining - 1;
        name(path, i);
        int fd = create(path);
        unsigned char value = (unsigned char)i;
        require(fd >= 0 && write(fd, &value, 1) == 1 && close(fd) == 0, path);
    }
    struct statfs after = usage();
    require(after.f_bavail > 0 && before.f_bfree - after.f_bfree >= count, "live file accounting");
    struct stat st;
    name(path, count - 1);
    require(lstat(path, &st) == 0 && st.st_size == 1, "last entry");
    printf("capacity entries=%u inode=%" PRIuMAX " blocks=%" PRIuMAX " free=%" PRIuMAX " block_bytes=%lu\n",
           count, (uintmax_t)st.st_ino, (uintmax_t)after.f_blocks, (uintmax_t)after.f_bfree, (unsigned long)after.f_bsize);
}

static void saved_computer(int seed)
{
    if (seed) {
        require(mkdir("saved-dir", 0750) == 0, "create saved directory");
        int fd = create("saved-dir/state");
        require(fd >= 0 && pwrite(fd, "journal", 7, 8192) == 7, "create sparse journal file");
        require(fchown(fd, 41, 52) == 0 && fchmod(fd, 0640) == 0, "set saved owner and mode");
        require(fsync(fd) == 0 && close(fd) == 0, "sync saved data");
        require(link("saved-dir/state", "saved-link") == 0 && symlink("saved-link", "saved-sym") == 0, "link saved file");
    }
    struct stat dir, file, link, sym;
    require(lstat("saved-dir", &dir) == 0 && lstat("saved-dir/state", &file) == 0 &&
            lstat("saved-link", &link) == 0 && lstat("saved-sym", &sym) == 0, "stat saved objects");
    require(file.st_ino == link.st_ino && file.st_nlink == 2 && S_ISLNK(sym.st_mode) &&
            file.st_uid == 41 && file.st_gid == 52 && (file.st_mode & 07777) == 0640, "saved identities");
    char contents[7];
    int fd = open("saved-sym", O_RDONLY);
    require(fd >= 0 && pread(fd, contents, sizeof(contents), 0) == 7 &&
            !memcmp(contents, (char[7]){0}, 7), "saved hole");
    require(pread(fd, contents, sizeof(contents), 8192) == 7 && !memcmp(contents, "journal", 7) &&
            close(fd) == 0, "saved file bytes");
    printf("saved objects %" PRIuMAX " %" PRIuMAX " %" PRIuMAX " size %" PRIuMAX " mtime %" PRIdMAX ".%ld\n",
           (uintmax_t)dir.st_ino, (uintmax_t)file.st_ino, (uintmax_t)sym.st_ino, (uintmax_t)file.st_size,
           (intmax_t)file.st_mtim.tv_sec, file.st_mtim.tv_nsec);
    struct statfs fs = usage();
    printf("geometry %" PRIuMAX " %" PRIuMAX "\n", (uintmax_t)fs.f_blocks, (uintmax_t)fs.f_files);
}

static uint64_t monotonic_ns(void)
{
    struct timespec ts;
    require(clock_gettime(CLOCK_MONOTONIC, &ts) == 0, "clock");
    return (uint64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}

enum { stat_file_count = 512, stat_calls = 512 };

static void seed_stat(void)
{
    require(mkdir("stat-workload", 0700) == 0 && chdir("stat-workload") == 0, "create stat directory");
    for (unsigned i = 0; i < stat_file_count; ++i) {
        char path[32];
        name(path, i);
        int fd = create(path);
        require(fd >= 0 && write(fd, "x", 1) == 1 && close(fd) == 0, "create stat file");
    }
}

/* Rotate the three syscall loops to avoid always timing one immediately
 * after opening the descriptors. The host alternates saved computers. */
static void warm_stat(unsigned width, uint32_t seed, unsigned first)
{
    require(chdir("stat-workload") == 0, "open saved stat directory");
    static char paths[stat_file_count][32];
    uint16_t requested[stat_calls];
    for (unsigned i = 0; i < width; ++i) name(paths[i], i);
    for (unsigned i = 0; i < stat_calls; ++i) {
        seed = seed * 1664525u + 1013904223u;
        requested[i] = (seed >> 16) % width;
    }
    int fd = open(paths[0], O_RDONLY);
    struct stat st;
    require(fd >= 0 && fstat(fd, &st) == 0 && st.st_size == 1, "open stat control descriptor");
    ino_t inode = st.st_ino;
    uint64_t checksum = 0;
    uint64_t elapsed[3];
    for (unsigned shift = 0; shift < 3; ++shift) {
        unsigned operation = (first + shift) % 3;
        uint64_t start = monotonic_ns();
        for (unsigned i = 0; i < stat_calls; ++i) {
            if (operation == 0) {
                require(stat(paths[requested[i]], &st) == 0 && st.st_size == 1 &&
                        S_ISREG(st.st_mode) && (st.st_mode & 0777) == 0600, "random pathname stat");
                checksum = checksum * 1099511628211u + (uint64_t)st.st_ino;
            } else if (operation == 1) {
                require(fstat(fd, &st) == 0 && st.st_ino == inode, "descriptor stat");
            } else {
                require(getppid() >= 0, "get parent pid");
            }
        }
        elapsed[operation] = monotonic_ns() - start;
    }
    require(close(fd) == 0, "close stat control descriptor");
    printf("warm-stat %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
           checksum, elapsed[0], elapsed[1], elapsed[2]);
}

/* Measure the common syscall path separately from pathname and data I/O. */
static void profile_path(void)
{
    enum { calls = 2048 };
    char path[32];
    name(path, 0);
    int fd = create(path);
    struct stat st;
    require(fd >= 0 && fstat(fd, &st) == 0, "create control file");
    ino_t ino = st.st_ino;
    uint64_t start = monotonic_ns();
    for (unsigned i = 0; i < calls; ++i)
        require(getppid() >= 0, "get parent pid");
    uint64_t pid_done = monotonic_ns();
    for (unsigned i = 0; i < calls; ++i)
        require(fstat(fd, &st) == 0 && st.st_ino == ino, "stat control descriptor");
    uint64_t fd_done = monotonic_ns();
    for (unsigned i = 0; i < calls; ++i) {
        name(path, 0);
        require(stat(path, &st) == 0 && st.st_ino == ino, "stat control name");
    }
    uint64_t path_done = monotonic_ns();
    require(close(fd) == 0 && unlink(path) == 0, "release control file");
    printf("path-control-ns %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
           pid_done - start, fd_done - pid_done, path_done - fd_done);
}

/* The harness snapshots positioned host I/O around each guest invocation.
 * Directory entries from one phase are the input to the next. */
static void profile_io(const char *mode)
{
    int empty = !strcmp(mode, "profile-empty"), modify = !strcmp(mode, "profile-write");
    int remove_files = !strcmp(mode, "profile-unlink");
    char path[32];
    uint64_t start = monotonic_ns();
    if (empty || modify || remove_files) {
        for (unsigned i = 0; i < 512; ++i) {
            name(path, i);
            if (remove_files) {
                require(unlink(path) == 0, "profile unlink");
            } else {
                int fd = empty ? create(path) : open(path, O_WRONLY);
                unsigned char value = (unsigned char)i;
                require(fd >= 0 && (empty || write(fd, &value, 1) == 1) && close(fd) == 0, "profile file");
            }
        }
    } else if (!strcmp(mode, "profile-stat")) {
        uint32_t random = 314159;
        for (unsigned i = 0; i < 2048; ++i) {
            random = random * 1664525u + 1013904223u;
            name(path, (random >> 16) % 512);
            struct stat st;
            require(stat(path, &st) == 0 && st.st_size == 1, "profile random stat");
        }
    } else if (!strcmp(mode, "profile-read")) {
        static unsigned char expected[65536], actual[sizeof(expected)];
        int fd = open("profile-stream-data", O_RDONLY);
        require(fd >= 0, "profile open stream for reading");
        for (unsigned i = 0; i < 32; ++i) {
            expected[0] = i;
            require(read(fd, actual, sizeof(actual)) == sizeof(actual) &&
                    memcmp(actual, expected, sizeof(actual)) == 0, "profile verify stream");
        }
        require(close(fd) == 0, "profile close read stream");
    } else if (!strcmp(mode, "profile-stream")) {
        static unsigned char block[65536];
        int fd = create("profile-stream-data");
        require(fd >= 0, "profile create stream");
        for (unsigned i = 0; i < 32; ++i) {
            block[0] = i;
            require(write(fd, block, sizeof(block)) == sizeof(block), "profile stream write");
        }
        require(close(fd) == 0, "profile close stream");
    } else {
        require(!strcmp(mode, "profile-sync"), "unknown profile operation");
        int fd = open("profile-stream-data", O_RDWR);
        require(fd >= 0, "profile open sync target");
        start = monotonic_ns();
        require(fsync(fd) == 0, "profile fsync");
        printf("profile-ns %" PRIu64 "\n", monotonic_ns() - start);
        require(close(fd) == 0, "profile close synced file");
        return;
    }
    printf("profile-ns %" PRIu64 "\n", monotonic_ns() - start);
}

static void compare_io(void)
{
    enum { files = 512, lookups = 2048, chunks = 32 };
    static unsigned char data[65536], received[sizeof(data)];
    char path[32];
    uint64_t start = monotonic_ns();
    for (unsigned i = 0; i < files; ++i) {
        name(path, i);
        int fd = create(path);
        unsigned char value = i;
        require(fd >= 0 && write(fd, &value, 1) == 1 && close(fd) == 0, "create small file");
    }
    uint64_t created = monotonic_ns();
    uint32_t random = 314159;
    for (unsigned i = 0; i < lookups; ++i) {
        random = random * 1664525u + 1013904223u;
        unsigned index = (random >> 16) % files;
        name(path, index);
        struct stat st;
        require(stat(path, &st) == 0 && st.st_size == 1, "random stat");
    }
    uint64_t found = monotonic_ns();
    for (unsigned i = 0; i < sizeof(data); ++i) data[i] = i % 251;
    int fd = open("stream", O_CREAT | O_EXCL | O_RDWR, 0600);
    require(fd >= 0, "create stream");
    uint64_t opened = monotonic_ns();
    for (unsigned i = 0; i < chunks; ++i) {
        data[0] = i;
        require(write(fd, data, sizeof(data)) == sizeof(data), "sequential write");
    }
    uint64_t writes_done = monotonic_ns();
    require(fsync(fd) == 0, "sync stream");
    uint64_t written = monotonic_ns();
    require(lseek(fd, 0, SEEK_SET) == 0, "rewind");
    for (unsigned i = 0; i < chunks; ++i) {
        data[0] = i;
        require(read(fd, received, sizeof(received)) == sizeof(received)
                && memcmp(received, data, sizeof(data)) == 0, "sequential read");
    }
    require(close(fd) == 0, "close stream");
    uint64_t read_done = monotonic_ns();
    require(unlink("stream") == 0, "release stream");
    uint64_t stream_removed = monotonic_ns();
    for (unsigned i = 0; i < files; ++i) {
        name(path, i);
        require(unlink(path) == 0, "release small file");
    }
    uint64_t removed = monotonic_ns();
    printf("guest-detail-ns %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
        writes_done - opened, written - writes_done, stream_removed - read_done, removed - stream_removed);
    printf("guest-io-ns %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
        created - start, found - created, written - found, read_done - written, removed - read_done);
}

int main(int argc, char **argv)
{
    require(argc >= 3 && chdir(argv[2]) == 0, "open workload parent");
    if (argc == 3 && (!strcmp(argv[1], "seed-saved") || !strcmp(argv[1], "check-saved"))) {
        saved_computer(!strcmp(argv[1], "seed-saved"));
        return 0;
    }
    if (argc == 3 && !strcmp(argv[1], "seed-stat")) {
        seed_stat();
        return 0;
    }
    if (argc == 6 && !strcmp(argv[1], "warm-stat")) {
        unsigned long width = strtoul(argv[3], NULL, 10);
        unsigned long seed = strtoul(argv[4], NULL, 10);
        unsigned long first = strtoul(argv[5], NULL, 10);
        require(width > 0 && width <= stat_file_count && seed <= UINT32_MAX && first < 3, "stat parameters");
        warm_stat((unsigned)width, (uint32_t)seed, (unsigned)first);
        return 0;
    }
    if (argc == 3 && !strcmp(argv[1], "profile-path")) {
        require(mkdir("capacity-test", 0700) == 0 && chdir("capacity-test") == 0, "create control directory");
        profile_path();
        require(chdir("..") == 0 && rmdir("capacity-test") == 0, "release control directory");
        return 0;
    }
    if (argc == 3 && !strncmp(argv[1], "profile-", 8)) {
        if (!strcmp(argv[1], "profile-empty")) require(mkdir("capacity-test", 0700) == 0, "create profile directory");
        require(chdir("capacity-test") == 0, "enter profile directory");
        profile_io(argv[1]);
        if (!strcmp(argv[1], "profile-unlink")) {
            require(unlink("profile-stream-data") == 0 && chdir("..") == 0 && rmdir("capacity-test") == 0, "clean profile");
        }
        return 0;
    }
    require(mkdir("capacity-test", 0700) == 0 && chdir("capacity-test") == 0, "create workload directory");
    if (argc == 3 && (!strcmp(argv[1], "compare") || !strcmp(argv[1], "compare-tmpfs"))) {
        if (!strcmp(argv[1], "compare-tmpfs")) require(usage().f_type == 0x01021994, "verify tmpfs control");
        compare_io();
        require(chdir("..") == 0 && rmdir("capacity-test") == 0, "release comparison directory");
    } else if (argc == 3 && !strcmp(argv[1], "fill")) {
        fill_small_volume();
        require(chdir("..") == 0 && rmdir("capacity-test") == 0, "reclaim directory");
    } else {
        require(argc == 4 && !strcmp(argv[1], "entries"), "expected entries count");
        char *end;
        unsigned long count = strtoul(argv[3], &end, 10);
        require(*end == 0 && count > 0 && count <= 1000000, "invalid entry count");
        many_files((unsigned)count);
    }
    return 0;
}
