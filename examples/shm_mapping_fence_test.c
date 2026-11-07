/*
 * Descriptor I/O on a file the kernel owns must agree with MAP_SHARED stores
 * already made to it, even when the storing process is the file's only
 * mapper and makes no further syscall.
 *
 * POSIX makes a mapping and read()/write() two views of one object. Kandelo
 * gives each process its own linear memory, so the kernel publishes a
 * process's mapped stores into the file only at defined points. Before any
 * syscall reads or writes the file's content -- read/pread, write/pwrite,
 * sendfile, copy_file_range, ftruncate, an O_TRUNC open, the pread that
 * populates a MAP_PRIVATE copy -- it publishes every mapping of that file
 * (the descriptor fence, `DescriptorFence` in
 * crates/runtime-core/src/memory.rs). Each case below makes a store whose
 * only route to the file is that fence:
 *
 *  - own-pread-after-store: the sole mapper reads its own store back through
 *    a descriptor with no syscall in between;
 *  - pread/sendfile/copy-file-range/private-map-after-edge: a child stores,
 *    tells the parent through a pipe and spins without syscalls; the parent,
 *    which never mapped the file, reads it;
 *  - truncate-drops-mapped-store: a store past a later truncation is dropped,
 *    not republished when the storing process exits;
 *  - pwrite-after-mapped-store: a pwrite made after a mapped store wins over
 *    it, even when the storing process exits afterwards.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/sendfile.h>
#include <sys/wait.h>
#include <unistd.h>

#define LEN 4096
#define PATTERN_LEN 64

static unsigned char pattern_byte(int seed, int i) {
    return (unsigned char)(seed * 41 + i * 13 + 5);
}

static void fill(volatile unsigned char *dst, int seed) {
    for (int i = 0; i < PATTERN_LEN; i++) dst[i] = pattern_byte(seed, i);
}

static int matches(const unsigned char *src, int seed) {
    for (int i = 0; i < PATTERN_LEN; i++) {
        if (src[i] != pattern_byte(seed, i)) return 0;
    }
    return 1;
}

static int all_zero(const unsigned char *src, int len) {
    for (int i = 0; i < len; i++) {
        if (src[i] != 0) return 0;
    }
    return 1;
}

/* Spin without making a syscall, so nothing this process stores after this
 * point can be published by one of its own syscalls. */
static void spin_forever(void) {
    volatile unsigned long n = 0;
    for (;;) n++;
}

static int new_file(const char *name) {
    int fd = memfd_create("kandelo-fence", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, LEN) < 0) {
        printf("FAIL %s: memfd: %s\n", name, strerror(errno));
        return -1;
    }
    return fd;
}

static int report(const char *name, int ok, const char *why) {
    if (ok) {
        printf("%s: PASS\n", name);
        return 0;
    }
    printf("FAIL %s: %s\n", name, why);
    return 1;
}

static void stop_child(pid_t pid) {
    if (pid <= 0) return;
    kill(pid, SIGKILL);
    waitpid(pid, NULL, 0);
}

/* Fork a child that maps `fd`, stores pattern `seed` at `offset`, signals the
 * parent through a pipe, and spins. Returns the child's pid once the store
 * has happened, or -1. */
static pid_t spawn_storing_child(int fd, int seed, off_t offset) {
    int p[2];
    if (pipe(p) < 0) return -1;
    pid_t pid = fork();
    if (pid == 0) {
        close(p[0]);
        volatile unsigned char *view =
            mmap(NULL, LEN, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (view == MAP_FAILED) _exit(2);
        fill(view + offset, seed);
        if (write(p[1], "s", 1) != 1) _exit(3);
        spin_forever();
    }
    close(p[1]);
    char byte;
    int ok = pid > 0 && read(p[0], &byte, 1) == 1;
    close(p[0]);
    if (!ok) {
        stop_child(pid);
        return -1;
    }
    return pid;
}

static int own_pread_after_store(void) {
    const char *name = "own-pread-after-store";
    int fd = new_file(name);
    if (fd < 0) return 1;
    unsigned char *view = mmap(NULL, LEN, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (view == MAP_FAILED) return report(name, 0, "mmap failed");
    fill(view, 1);
    unsigned char buf[PATTERN_LEN];
    int ok = pread(fd, buf, sizeof buf, 0) == (ssize_t)sizeof buf && matches(buf, 1);
    munmap(view, LEN);
    close(fd);
    return report(name, ok, "pread did not see the mapping's store");
}

static int pread_after_edge(void) {
    const char *name = "pread-after-edge";
    int fd = new_file(name);
    if (fd < 0) return 1;
    pid_t pid = spawn_storing_child(fd, 2, 0);
    unsigned char buf[PATTERN_LEN];
    int ok = pid > 0 && pread(fd, buf, sizeof buf, 0) == (ssize_t)sizeof buf
        && matches(buf, 2);
    stop_child(pid);
    close(fd);
    return report(name, ok, "pread did not see the child's store");
}

static int sendfile_after_edge(void) {
    const char *name = "sendfile-after-edge";
    int fd = new_file(name);
    if (fd < 0) return 1;
    int out[2];
    if (pipe(out) < 0) return report(name, 0, "pipe failed");
    pid_t pid = spawn_storing_child(fd, 3, 0);
    off_t offset = 0;
    unsigned char buf[PATTERN_LEN];
    int ok = pid > 0
        && sendfile(out[1], fd, &offset, PATTERN_LEN) == PATTERN_LEN
        && read(out[0], buf, sizeof buf) == (ssize_t)sizeof buf
        && matches(buf, 3);
    stop_child(pid);
    close(out[0]);
    close(out[1]);
    close(fd);
    return report(name, ok, "sendfile did not carry the child's store");
}

static int copy_file_range_after_edge(void) {
    const char *name = "copy-file-range-after-edge";
    int fd = new_file(name);
    if (fd < 0) return 1;
    int dst = memfd_create("kandelo-fence-copy", MFD_CLOEXEC);
    if (dst < 0) return report(name, 0, "memfd failed");
    pid_t pid = spawn_storing_child(fd, 4, 0);
    loff_t in_off = 0, out_off = 0;
    unsigned char buf[PATTERN_LEN];
    int ok = pid > 0
        && copy_file_range(fd, &in_off, dst, &out_off, PATTERN_LEN, 0) == PATTERN_LEN
        && pread(dst, buf, sizeof buf, 0) == (ssize_t)sizeof buf
        && matches(buf, 4);
    stop_child(pid);
    close(dst);
    close(fd);
    return report(name, ok, "copy_file_range did not carry the child's store");
}

static int private_map_after_edge(void) {
    const char *name = "private-map-after-edge";
    int fd = new_file(name);
    if (fd < 0) return 1;
    pid_t pid = spawn_storing_child(fd, 5, 0);
    int ok = 0;
    if (pid > 0) {
        unsigned char *copy = mmap(NULL, LEN, PROT_READ, MAP_PRIVATE, fd, 0);
        if (copy != MAP_FAILED) {
            ok = matches(copy, 5);
            munmap(copy, LEN);
        }
    }
    stop_child(pid);
    close(fd);
    return report(name, ok, "the private copy did not start from the child's store");
}

/* The child's store lies past the size the parent truncates to. POSIX drops
 * those bytes; growing the file again must expose zeros, and the child's
 * final publication at exit must not bring the store back. */
static int truncate_drops_mapped_store(void) {
    const char *name = "truncate-drops-mapped-store";
    int fd = new_file(name);
    if (fd < 0) return 1;
    pid_t pid = spawn_storing_child(fd, 6, 2048);
    int ok = pid > 0 && ftruncate(fd, 1024) == 0 && ftruncate(fd, LEN) == 0;
    stop_child(pid);
    unsigned char buf[PATTERN_LEN];
    ok = ok && pread(fd, buf, sizeof buf, 2048) == (ssize_t)sizeof buf
        && all_zero(buf, sizeof buf);
    close(fd);
    return report(name, ok, "a store past the truncation reappeared");
}

/* A pwrite the parent makes after learning of the child's store lands after
 * it, so its bytes are the file's, including after the child exits. */
static int pwrite_after_mapped_store(void) {
    const char *name = "pwrite-after-mapped-store";
    int fd = new_file(name);
    if (fd < 0) return 1;
    pid_t pid = spawn_storing_child(fd, 7, 0);
    unsigned char mine[PATTERN_LEN];
    for (int i = 0; i < PATTERN_LEN; i++) mine[i] = pattern_byte(8, i);
    int ok = pid > 0 && pwrite(fd, mine, sizeof mine, 0) == (ssize_t)sizeof mine;
    stop_child(pid);
    unsigned char buf[PATTERN_LEN];
    ok = ok && pread(fd, buf, sizeof buf, 0) == (ssize_t)sizeof buf && matches(buf, 8);
    close(fd);
    return report(name, ok, "the earlier mapped store overwrote the later pwrite");
}

int main(void) {
    int failures = 0;
    failures += own_pread_after_store();
    failures += pread_after_edge();
    failures += sendfile_after_edge();
    failures += copy_file_range_after_edge();
    failures += private_map_after_edge();
    failures += truncate_drops_mapped_store();
    failures += pwrite_after_mapped_store();
    if (failures == 0) printf("SHM_MAPPING_FENCE_PASS\n");
    return failures == 0 ? 0 : 1;
}
