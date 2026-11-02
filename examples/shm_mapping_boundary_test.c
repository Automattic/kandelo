/*
 * When MAP_SHARED stores made by one process reach another, for a mapping of
 * a file the kernel owns (here a memfd, the way a Wayland client hands a
 * buffer pool to its compositor).
 *
 * Kandelo gives each process its own linear memory and makes mappings agree
 * at syscall boundaries (docs/posix-status.md, mmap()). The kernel may skip
 * re-comparing a mapping at the completion of a syscall when it can prove
 * nothing wrote it since the same syscall's entry (BoundaryRecord in
 * crates/runtime-core/src/memory.rs). Each case below is a way the bytes can
 * change in that interval, or right after it, and checks the peer still sees
 * them no later than before:
 *
 *  - guest stores made after a quiet syscall publish at the next syscall;
 *  - bytes a syscall itself delivers into the mapping (a read() into the
 *    mapped buffer) publish at that syscall's completion, observed before the
 *    reader makes any further syscall;
 *  - stores by a second thread made while the first is parked in a syscall
 *    publish at that syscall's completion;
 *  - stores made by a signal handler publish at the next syscall;
 *  - stores made by a forked child publish at its next syscall.
 *
 * The cases that must observe a publication before the writer's next syscall
 * leave the writer spinning without syscalls and kill it afterwards.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define LEN 65536
#define PATTERN_LEN 64
/* Polls of at most 1 ms each before a case gives up: 20 s. */
#define POLL_LIMIT 20000

static unsigned char pattern_byte(int seed, int i) {
    return (unsigned char)(seed * 37 + i * 11 + 3);
}

static void fill(volatile unsigned char *dst, int seed) {
    for (int i = 0; i < PATTERN_LEN; i++) dst[i] = pattern_byte(seed, i);
}

static int matches(const volatile unsigned char *src, int seed) {
    for (int i = 0; i < PATTERN_LEN; i++) {
        if (src[i] != pattern_byte(seed, i)) return 0;
    }
    return 1;
}

static void sleep_ms(long ms) {
    struct timespec ts = {ms / 1000, (ms % 1000) * 1000000L};
    nanosleep(&ts, NULL);
}

/* Spin without making a syscall, so nothing this process stores after this
 * point can publish. */
static void spin_forever(void) {
    volatile unsigned long n = 0;
    for (;;) n++;
}

static void busy_wait(unsigned long iterations) {
    volatile unsigned long n = 0;
    while (n < iterations) n++;
}

/* Every poll is a syscall boundary of this process, at which it imports what
 * peers published. */
static int wait_for(const volatile unsigned char *view, int seed) {
    for (int i = 0; i < POLL_LIMIT; i++) {
        if (matches(view, seed)) return 1;
        sleep_ms(1);
    }
    return matches(view, seed);
}

static int wait_pipe_drained(int fd) {
    for (int i = 0; i < POLL_LIMIT; i++) {
        int pending = -1;
        if (ioctl(fd, FIONREAD, &pending) == 0 && pending == 0) return 1;
        sleep_ms(1);
    }
    return 0;
}

static volatile unsigned char *new_pool(const char *name, int *fd_out) {
    int fd = memfd_create("kandelo-boundary", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, LEN) < 0) {
        printf("FAIL %s: memfd: %s\n", name, strerror(errno));
        return NULL;
    }
    void *p = mmap(NULL, LEN, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) {
        printf("FAIL %s: mmap: %s\n", name, strerror(errno));
        return NULL;
    }
    *fd_out = fd;
    return p;
}

static int finish(const char *name, int ok, pid_t child, volatile unsigned char *view, int fd) {
    if (child > 0) {
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
    }
    munmap((void *)view, LEN);
    close(fd);
    if (!ok) {
        printf("FAIL %s: the peer's bytes never arrived\n", name);
        return 1;
    }
    printf("%s: PASS\n", name);
    return 0;
}

/* The child's syscalls before the store complete quietly (no output, single
 * thread); its store must still publish at its next syscall. */
static int store_after_quiet_syscalls(void) {
    const char *name = "store-after-quiet-syscalls";
    int fd;
    volatile unsigned char *view = new_pool(name, &fd);
    if (!view) return 1;
    pid_t pid = fork();
    if (pid == 0) {
        for (int i = 0; i < 8; i++) (void)getppid();
        fill(view, 1);
        (void)getppid();
        pause();
        _exit(0);
    }
    return finish(name, pid > 0 && wait_for(view, 1), pid, view, fd);
}

/* read() delivers bytes into the mapped buffer. They are the syscall's own
 * output, so its completion publishes them; the reader then spins, and the
 * writer of the pipe sees the bytes as soon as the pipe is drained. */
static int syscall_output_into_mapping(void) {
    const char *name = "syscall-output-into-mapping";
    int fd;
    volatile unsigned char *view = new_pool(name, &fd);
    if (!view) return 1;
    int p[2];
    if (pipe(p) < 0) return finish(name, 0, -1, view, fd);
    pid_t pid = fork();
    if (pid == 0) {
        close(p[1]);
        if (read(p[0], (void *)view, PATTERN_LEN) != PATTERN_LEN) _exit(2);
        spin_forever();
    }
    unsigned char buf[PATTERN_LEN];
    for (int i = 0; i < PATTERN_LEN; i++) buf[i] = pattern_byte(2, i);
    int ok = pid > 0 && write(p[1], buf, sizeof buf) == (ssize_t)sizeof buf
        && wait_pipe_drained(p[0]) && wait_for(view, 2);
    close(p[0]);
    close(p[1]);
    return finish(name, ok, pid, view, fd);
}

static atomic_int sibling_go;
static volatile unsigned char *sibling_view;

static void *sibling_store(void *arg) {
    (void)arg;
    while (!atomic_load(&sibling_go)) {}
    /* Give the main thread time to park in its read(). */
    busy_wait(200000000UL);
    fill(sibling_view, 3);
    spin_forever();
    return NULL;
}

/* A second thread stores while the main thread is parked in read(). Neither
 * thread makes another syscall afterwards, so only the read()'s completion
 * can publish the store. */
static int sibling_thread_store(void) {
    const char *name = "sibling-thread-store";
    int fd;
    volatile unsigned char *view = new_pool(name, &fd);
    if (!view) return 1;
    int p[2];
    if (pipe(p) < 0) return finish(name, 0, -1, view, fd);
    pid_t pid = fork();
    if (pid == 0) {
        close(p[1]);
        sibling_view = view;
        pthread_t thread;
        if (pthread_create(&thread, NULL, sibling_store, NULL) != 0) _exit(2);
        char byte;
        atomic_store(&sibling_go, 1);
        if (read(p[0], &byte, 1) != 1) _exit(3);
        spin_forever();
    }
    /* Let the sibling store first; it stays unpublished until the read()
     * completes. */
    sleep_ms(1500);
    int ok = pid > 0 && write(p[1], "x", 1) == 1 && wait_pipe_drained(p[0])
        && wait_for(view, 3);
    close(p[0]);
    close(p[1]);
    return finish(name, ok, pid, view, fd);
}

static volatile unsigned char *handler_view;

static void store_in_handler(int signo) {
    (void)signo;
    fill(handler_view, 4);
}

/* A signal handler runs as guest code after a syscall completes; its store
 * publishes at the next syscall. */
static int signal_handler_store(void) {
    const char *name = "signal-handler-store";
    int fd;
    volatile unsigned char *view = new_pool(name, &fd);
    if (!view) return 1;
    int ready[2];
    if (pipe(ready) < 0) return finish(name, 0, -1, view, fd);
    pid_t pid = fork();
    if (pid == 0) {
        close(ready[0]);
        handler_view = view;
        struct sigaction sa;
        memset(&sa, 0, sizeof sa);
        sa.sa_handler = store_in_handler;
        if (sigaction(SIGUSR1, &sa, NULL) < 0) _exit(2);
        if (write(ready[1], "r", 1) != 1) _exit(3);
        for (;;) pause();
    }
    close(ready[1]);
    char byte;
    int ok = pid > 0 && read(ready[0], &byte, 1) == 1 && kill(pid, SIGUSR1) == 0
        && wait_for(view, 4);
    close(ready[0]);
    return finish(name, ok, pid, view, fd);
}

/* The parent stores after quiet syscalls; the forked child, which inherited
 * the mapping, must see it. */
static int forked_child_observes_parent(void) {
    const char *name = "forked-child-observes-parent";
    int fd;
    volatile unsigned char *view = new_pool(name, &fd);
    if (!view) return 1;
    int ready[2];
    if (pipe(ready) < 0) return finish(name, 0, -1, view, fd);
    pid_t pid = fork();
    if (pid == 0) {
        close(ready[0]);
        _exit(wait_for(view, 5) ? 0 : 1);
    }
    close(ready[1]);
    for (int i = 0; i < 8; i++) (void)getpid();
    fill(view, 5);
    (void)getpid();
    int status = 0;
    int ok = pid > 0 && waitpid(pid, &status, 0) == pid && WIFEXITED(status)
        && WEXITSTATUS(status) == 0;
    close(ready[0]);
    return finish(name, ok, -1, view, fd);
}

int main(void) {
    int failures = 0;
    failures += store_after_quiet_syscalls();
    failures += syscall_output_into_mapping();
    failures += sibling_thread_store();
    failures += signal_handler_store();
    failures += forked_child_observes_parent();
    if (failures == 0) printf("SHM_MAPPING_BOUNDARY_PASS\n");
    return failures == 0 ? 0 : 1;
}
