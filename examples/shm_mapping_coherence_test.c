/*
 * MAP_SHARED mappings of one file the kernel owns -- a POSIX shared-memory
 * object under /dev/shm, a memfd, a /tmp file -- are views of that one file,
 * not copies taken at mmap() time. Two mappings must see each other's stores,
 * across fork() and across independent opens, and a write() through a
 * descriptor must show through an existing mapping.
 *
 * Kandelo gives each process its own linear memory, so it makes the views
 * agree at syscall boundaries rather than on every store (docs/posix-status.md,
 * mmap()). Every check below therefore makes one ordinary syscall after the
 * peer's write is known to have happened before it reads.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define LEN 4096
#define PATTERN_LEN 64

static unsigned char pattern_byte(int seed, int i) {
    return (unsigned char)(seed * 31 + i * 7 + 1);
}

static void fill(unsigned char *dst, int seed) {
    for (int i = 0; i < PATTERN_LEN; i++) dst[i] = pattern_byte(seed, i);
}

static int check(const unsigned char *src, int seed, const char *name) {
    /* One unrelated syscall: the boundary at which this process's view is
     * brought up to date with what peers published. */
    (void)getpid();
    for (int i = 0; i < PATTERN_LEN; i++) {
        if (src[i] != pattern_byte(seed, i)) {
            printf("FAIL %s: byte %d = 0x%02x, expected 0x%02x\n", name, i,
                   src[i], pattern_byte(seed, i));
            return 1;
        }
    }
    printf("%s: PASS\n", name);
    return 0;
}

static unsigned char *map_fd(int fd, const char *name) {
    void *p = mmap(NULL, LEN, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) {
        printf("FAIL %s: mmap: %s\n", name, strerror(errno));
        return NULL;
    }
    return p;
}

static int wait_child(pid_t pid, const char *name) {
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) {
        printf("FAIL %s: waitpid: %s\n", name, strerror(errno));
        return 1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("FAIL %s: child status 0x%x\n", name, status);
        return 1;
    }
    return 0;
}

static int shm_fd(const char *path, int truncate) {
    int fd = shm_open(path, O_CREAT | O_RDWR, 0600);
    if (fd < 0) return -1;
    if (truncate && ftruncate(fd, LEN) < 0) return -1;
    return fd;
}

/* Two shm_open() descriptors of one object, mapped twice in one process. */
static int two_opens_one_process(void) {
    const char *name = "two-opens-one-process";
    const char *path = "/kandelo-coherence-a";
    shm_unlink(path);
    int fd1 = shm_fd(path, 1);
    int fd2 = shm_fd(path, 0);
    if (fd1 < 0 || fd2 < 0) {
        printf("FAIL %s: shm_open: %s\n", name, strerror(errno));
        return 1;
    }
    unsigned char *a = map_fd(fd1, name);
    unsigned char *b = map_fd(fd2, name);
    if (!a || !b) return 1;
    fill(a, 1);
    int rc = check(b, 1, name);
    munmap(a, LEN);
    munmap(b, LEN);
    close(fd1);
    close(fd2);
    shm_unlink(path);
    return rc;
}

/* A mapping inherited across fork(): the child writes and exits. */
static int inherited_across_fork(void) {
    const char *name = "inherited-across-fork";
    const char *path = "/kandelo-coherence-b";
    shm_unlink(path);
    int fd = shm_fd(path, 1);
    if (fd < 0) {
        printf("FAIL %s: shm_open: %s\n", name, strerror(errno));
        return 1;
    }
    unsigned char *view = map_fd(fd, name);
    if (!view) return 1;
    memset(view, 0xEE, PATTERN_LEN);
    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL %s: fork: %s\n", name, strerror(errno));
        return 1;
    }
    if (pid == 0) {
        fill(view, 2);
        _exit(0);
    }
    if (wait_child(pid, name)) return 1;
    int rc = check(view, 2, name);
    munmap(view, LEN);
    close(fd);
    shm_unlink(path);
    return rc;
}

/* The child opens the object by name itself, after the parent unlinked
 * nothing: two independent opens in two processes. The parent closes its
 * descriptor before the child writes -- the mapping must outlive it. */
static int independent_opens_across_processes(void) {
    const char *name = "independent-opens";
    const char *path = "/kandelo-coherence-c";
    shm_unlink(path);
    int fd = shm_fd(path, 1);
    if (fd < 0) {
        printf("FAIL %s: shm_open: %s\n", name, strerror(errno));
        return 1;
    }
    unsigned char *view = map_fd(fd, name);
    if (!view) return 1;
    close(fd);
    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL %s: fork: %s\n", name, strerror(errno));
        return 1;
    }
    if (pid == 0) {
        munmap(view, LEN);
        int cfd = shm_fd(path, 0);
        if (cfd < 0) _exit(2);
        unsigned char *mine = mmap(NULL, LEN, PROT_READ | PROT_WRITE,
                                   MAP_SHARED, cfd, 0);
        if (mine == MAP_FAILED) _exit(3);
        fill(mine, 3);
        _exit(0);
    }
    if (wait_child(pid, name)) return 1;
    int rc = check(view, 3, name);
    munmap(view, LEN);
    shm_unlink(path);
    return rc;
}

/* A memfd shared across fork(), the way a Wayland client hands a buffer
 * pool to a compositor. */
static int memfd_across_fork(void) {
    const char *name = "memfd-across-fork";
    int fd = memfd_create("kandelo-coherence", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, LEN) < 0) {
        printf("FAIL %s: memfd: %s\n", name, strerror(errno));
        return 1;
    }
    unsigned char *view = map_fd(fd, name);
    if (!view) return 1;
    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL %s: fork: %s\n", name, strerror(errno));
        return 1;
    }
    if (pid == 0) {
        unsigned char *mine = map_fd(fd, name);
        if (!mine) _exit(2);
        fill(mine, 4);
        _exit(0);
    }
    if (wait_child(pid, name)) return 1;
    int rc = check(view, 4, name);
    munmap(view, LEN);
    close(fd);
    return rc;
}

/* A write() through a descriptor shows through an existing mapping, and a
 * store through the mapping is what read() returns after msync(). */
static int descriptor_and_mapping_agree(void) {
    const char *name = "descriptor-and-mapping";
    const char *path = "/tmp/kandelo-coherence-d";
    unlink(path);
    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0600);
    if (fd < 0 || ftruncate(fd, LEN) < 0) {
        printf("FAIL %s: open: %s\n", name, strerror(errno));
        return 1;
    }
    unsigned char *view = map_fd(fd, name);
    if (!view) return 1;
    unsigned char buf[PATTERN_LEN];
    fill(buf, 5);
    if (pwrite(fd, buf, PATTERN_LEN, 0) != PATTERN_LEN) {
        printf("FAIL %s: pwrite: %s\n", name, strerror(errno));
        return 1;
    }
    if (check(view, 5, name)) return 1;
    fill(view, 6);
    if (msync(view, LEN, MS_SYNC) < 0) {
        printf("FAIL %s: msync: %s\n", name, strerror(errno));
        return 1;
    }
    memset(buf, 0, sizeof buf);
    if (pread(fd, buf, PATTERN_LEN, 0) != PATTERN_LEN) {
        printf("FAIL %s: pread: %s\n", name, strerror(errno));
        return 1;
    }
    for (int i = 0; i < PATTERN_LEN; i++) {
        if (buf[i] != pattern_byte(6, i)) {
            printf("FAIL %s: read() byte %d = 0x%02x after msync\n", name, i,
                   buf[i]);
            return 1;
        }
    }
    printf("%s-read: PASS\n", name);
    munmap(view, LEN);
    close(fd);
    unlink(path);
    return 0;
}

int main(void) {
    int failures = 0;
    failures += two_opens_one_process();
    failures += inherited_across_fork();
    failures += independent_opens_across_processes();
    failures += memfd_across_fork();
    failures += descriptor_and_mapping_agree();
    if (failures == 0) printf("SHM_MAPPING_COHERENCE_PASS\n");
    return failures == 0 ? 0 : 1;
}
