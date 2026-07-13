#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>

static volatile sig_atomic_t sigxfsz_count;

static void on_sigxfsz(int signo)
{
    (void)signo;
    sigxfsz_count++;
}

static int set_fsize_limit(rlim_t limit)
{
    struct rlimit value = {
        .rlim_cur = limit,
        .rlim_max = RLIM_INFINITY,
    };
    return setrlimit(RLIMIT_FSIZE, &value);
}

static int open_test_file(const char *path, int flags)
{
    int fd = open(path, flags | O_CREAT | O_TRUNC, 0600);
    if (fd < 0)
        perror(path);
    return fd;
}

static int fail(const char *step)
{
    fprintf(stderr, "RLIMIT_FSIZE_FAIL: %s (errno=%d signals=%d)\n",
        step, errno, (int)sigxfsz_count);
    return 1;
}

static int test_scalar_and_large_writes(void)
{
    int fd = open_test_file("/tmp/fsize-scalar", O_WRONLY);
    if (fd < 0 || set_fsize_limit(5) != 0)
        return fail("scalar setup");

    sigxfsz_count = 0;
    if (write(fd, "abcdefgh", 8) != 5 || sigxfsz_count != 0)
        return fail("scalar crossing write");
    if (write(fd, "", 0) != 0 || sigxfsz_count != 0)
        return fail("zero write at limit");
    errno = 0;
    if (write(fd, "x", 1) != -1 || errno != EFBIG || sigxfsz_count != 1)
        return fail("scalar write at limit");
    close(fd);

    char *large = malloc(65537);
    if (!large)
        return fail("large allocation");
    memset(large, 'L', 65537);

    fd = open_test_file("/tmp/fsize-large-write", O_WRONLY);
    if (fd < 0 || set_fsize_limit(65536) != 0)
        return fail("large write setup");
    sigxfsz_count = 0;
    if (write(fd, large, 65537) != 65536 || sigxfsz_count != 0)
        return fail("64KiB write operation boundary");
    errno = 0;
    if (write(fd, large, 65537) != -1 || errno != EFBIG || sigxfsz_count != 1)
        return fail("large write preflight at limit");
    close(fd);

    fd = open_test_file("/tmp/fsize-large-pwrite", O_WRONLY);
    if (fd < 0 || set_fsize_limit(65536) != 0)
        return fail("large pwrite setup");
    sigxfsz_count = 0;
    if (pwrite(fd, large, 65537, 0) != 65536 || sigxfsz_count != 0)
        return fail("64KiB pwrite operation boundary");
    errno = 0;
    if (pwrite(fd, large, 65537, 65536) != -1 || errno != EFBIG || sigxfsz_count != 1)
        return fail("large pwrite preflight at limit");
    close(fd);

    struct iovec large_iov[2] = {
        { .iov_base = large, .iov_len = 65536 },
        { .iov_base = large + 65536, .iov_len = 1 },
    };
    fd = open_test_file("/tmp/fsize-large-writev", O_WRONLY);
    if (fd < 0 || set_fsize_limit(65536) != 0)
        return fail("large writev setup");
    sigxfsz_count = 0;
    if (writev(fd, large_iov, 2) != 65536 || sigxfsz_count != 0)
        return fail("large writev host decomposition");
    errno = 0;
    if (writev(fd, large_iov, 2) != -1 || errno != EFBIG || sigxfsz_count != 1)
        return fail("large writev preflight at limit");
    close(fd);

    fd = open_test_file("/tmp/fsize-large-pwritev", O_WRONLY);
    if (fd < 0 || set_fsize_limit(65536) != 0)
        return fail("large pwritev setup");
    sigxfsz_count = 0;
    if (pwritev(fd, large_iov, 2, 0) != 65536 || sigxfsz_count != 0)
        return fail("large pwritev host decomposition");
    errno = 0;
    if (pwritev(fd, large_iov, 2, 65536) != -1 || errno != EFBIG ||
        sigxfsz_count != 1)
        return fail("large pwritev preflight at limit");
    close(fd);

    // The slow pwritev host path receives the offset as split low/high words.
    // A low word with bit 31 set must remain unsigned during reconstruction.
    fd = open_test_file("/tmp/fsize-pwritev-split", O_WRONLY);
    off_t split_offset = (off_t)0xffffffffULL;
    if (fd < 0 || set_fsize_limit((rlim_t)split_offset) != 0)
        return fail("split-offset pwritev setup");
    sigxfsz_count = 0;
    errno = 0;
    if (pwritev(fd, large_iov, 2, split_offset) != -1 || errno != EFBIG ||
        sigxfsz_count != 1)
        return fail("split-offset pwritev preflight");
    close(fd);

#if __SIZEOF_POINTER__ == 8
    fd = open_test_file("/tmp/fsize-unreportable-count", O_WRONLY);
    if (fd < 0 || set_fsize_limit(RLIM_INFINITY) != 0)
        return fail("unreportable count setup");
    errno = 0;
    if (syscall(SYS_write, fd, large, (size_t)INT32_MAX + 1) != -1 ||
        errno != EINVAL)
        return fail("unreportable wasm64 write count");
    close(fd);
#endif

    free(large);
    return 0;
}

static int test_vectors_and_large_limit(void)
{
    struct iovec iov[3] = {
        { .iov_base = (void *)"ab", .iov_len = 2 },
        { .iov_base = (void *)"cde", .iov_len = 3 },
        { .iov_base = (void *)"f", .iov_len = 1 },
    };
    int fd = open_test_file("/tmp/fsize-writev", O_WRONLY);
    if (fd < 0 || set_fsize_limit(5) != 0)
        return fail("writev setup");
    sigxfsz_count = 0;
    if (writev(fd, iov, 3) != 5 || sigxfsz_count != 0)
        return fail("writev exact iovec boundary");
    struct iovec next = { .iov_base = (void *)"x", .iov_len = 1 };
    errno = 0;
    if (writev(fd, &next, 1) != -1 || errno != EFBIG || sigxfsz_count != 1)
        return fail("writev next operation");
    close(fd);

    fd = open_test_file("/tmp/fsize-pwritev", O_WRONLY);
    if (fd < 0 || set_fsize_limit(5) != 0)
        return fail("pwritev setup");
    sigxfsz_count = 0;
    if (pwritev(fd, iov, 3, 0) != 5 || sigxfsz_count != 0)
        return fail("pwritev exact iovec boundary");
    errno = 0;
    if (pwritev(fd, &next, 1, 5) != -1 || errno != EFBIG || sigxfsz_count != 1)
        return fail("pwritev next operation");
    close(fd);

    // The kernel is wasm32 for both guest architectures. This small write
    // catches a remaining-budget conversion that wraps modulo 2^32.
    fd = open_test_file("/tmp/fsize-large-limit", O_WRONLY);
    rlim_t large_limit = ((rlim_t)1 << 32) + 5;
    if (fd < 0 || set_fsize_limit(large_limit) != 0)
        return fail("large limit setup");
    sigxfsz_count = 0;
    if (write(fd, "0123456789", 10) != 10 || sigxfsz_count != 0)
        return fail("limit above wasm32 range");
    close(fd);
    return 0;
}

static int test_memfd_truncate_and_nonfiles(void)
{
    int fd = memfd_create("fsize", 0);
    if (fd < 0 || ftruncate(fd, 20) != 0 || set_fsize_limit(10) != 0)
        return fail("memfd setup");
    sigxfsz_count = 0;
    if (ftruncate(fd, 15) != 0 || sigxfsz_count != 0)
        return fail("memfd shrink above limit");
    if (ftruncate(fd, 0) != 0 || set_fsize_limit(5) != 0)
        return fail("memfd reset");
    sigxfsz_count = 0;
    if (write(fd, "abcdefgh", 8) != 5 || sigxfsz_count != 0)
        return fail("memfd crossing write");
    errno = 0;
    if (pwrite(fd, "x", 1, 5) != -1 || errno != EFBIG || sigxfsz_count != 1)
        return fail("memfd positioned limit");
    sigxfsz_count = 0;
    errno = 0;
    if (ftruncate(fd, 6) != -1 || errno != EFBIG || sigxfsz_count != 1)
        return fail("memfd truncate limit");
    sigxfsz_count = 0;
    errno = 0;
    if (fallocate(fd, 0, 5, 1) != -1 || errno != EFBIG || sigxfsz_count != 1)
        return fail("memfd fallocate limit");
    close(fd);

    int pipefd[2];
    if (pipe(pipefd) != 0 || set_fsize_limit(1) != 0)
        return fail("pipe setup");
    sigxfsz_count = 0;
    if (write(pipefd[1], "abc", 3) != 3 || sigxfsz_count != 0)
        return fail("pipe unaffected");
    char data[3];
    if (read(pipefd[0], data, sizeof(data)) != 3 || memcmp(data, "abc", 3) != 0)
        return fail("pipe readback");
    close(pipefd[0]);
    close(pipefd[1]);

    char *large = malloc(65537);
    if (!large)
        return fail("closed-pipe vector allocation");
    memset(large, 'P', 65537);
    struct iovec large_iov = { .iov_base = large, .iov_len = 65537 };
    if (pipe(pipefd) != 0 || set_fsize_limit(RLIM_INFINITY) != 0)
        return fail("closed-pipe vector setup");
    close(pipefd[0]);
    sigxfsz_count = 0;
    errno = 0;
    if (writev(pipefd[1], &large_iov, 1) != -1 || errno != EPIPE ||
        sigxfsz_count != 1)
        return fail("closed-pipe vector preserves EPIPE");
    close(pipefd[1]);
    free(large);
    return 0;
}

static volatile int thread_phase;
static int thread_fd;
static int worker_errno;
static ssize_t worker_result;

static void *blocked_writer(void *unused)
{
    (void)unused;
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGXFSZ);
    pthread_sigmask(SIG_BLOCK, &set, NULL);
    errno = 0;
    worker_result = write(thread_fd, "x", 1);
    worker_errno = errno;
    __atomic_store_n(&thread_phase, 1, __ATOMIC_RELEASE);
    while (__atomic_load_n(&thread_phase, __ATOMIC_ACQUIRE) != 2) {
    }

    pthread_sigmask(SIG_UNBLOCK, &set, NULL);
    (void)syscall(SYS_getpid);
    __atomic_store_n(&thread_phase, 3, __ATOMIC_RELEASE);
    return NULL;
}

static void *unblocked_observer(void *unused)
{
    (void)unused;
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGXFSZ);
    pthread_sigmask(SIG_UNBLOCK, &set, NULL);
    __atomic_store_n(&thread_phase, 1, __ATOMIC_RELEASE);
    while (__atomic_load_n(&thread_phase, __ATOMIC_ACQUIRE) != 2) {
    }
    (void)syscall(SYS_getpid);
    __atomic_store_n(&thread_phase, 3, __ATOMIC_RELEASE);
    return NULL;
}

static int test_sigxfsz_targets_calling_thread(void)
{
    thread_fd = open_test_file("/tmp/fsize-thread", O_WRONLY);
    int wake_pipe[2];
    if (thread_fd < 0 || pipe(wake_pipe) != 0 || set_fsize_limit(0) != 0)
        return fail("thread signal setup");

    sigxfsz_count = 0;
    thread_phase = 0;
    pthread_t thread;
    if (pthread_create(&thread, NULL, blocked_writer, NULL) != 0)
        return fail("pthread_create");
    while (__atomic_load_n(&thread_phase, __ATOMIC_ACQUIRE) != 1) {
    }

    if (worker_result != -1 || worker_errno != EFBIG || sigxfsz_count != 0)
        return fail("blocked worker write");

    // A process-shared pending signal would be delivered to this unblocked
    // main thread at the next syscall. A thread-directed signal stays with the
    // blocked writer until that same thread unmasks it.
    if (write(wake_pipe[1], "w", 1) != 1 || sigxfsz_count != 0)
        return fail("signal escaped to main thread");

    __atomic_store_n(&thread_phase, 2, __ATOMIC_RELEASE);
    while (__atomic_load_n(&thread_phase, __ATOMIC_ACQUIRE) != 3) {
    }
    if (pthread_join(thread, NULL) != 0)
        return fail("pthread_join");
    if (sigxfsz_count != 1)
        return fail("signal did not return to writer thread");

    // Check the inverse direction. A SIGXFSZ generated while the main thread
    // blocks it must not be visible to an unblocked worker.
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGXFSZ);
    sigxfsz_count = 0;
    thread_phase = 0;
    if (pthread_create(&thread, NULL, unblocked_observer, NULL) != 0)
        return fail("observer pthread_create");
    while (__atomic_load_n(&thread_phase, __ATOMIC_ACQUIRE) != 1) {
    }
    if (pthread_sigmask(SIG_BLOCK, &set, NULL) != 0)
        return fail("main signal block");
    errno = 0;
    if (write(thread_fd, "x", 1) != -1 || errno != EFBIG || sigxfsz_count != 0)
        return fail("blocked main write");
    __atomic_store_n(&thread_phase, 2, __ATOMIC_RELEASE);
    while (__atomic_load_n(&thread_phase, __ATOMIC_ACQUIRE) != 3) {
    }
    if (sigxfsz_count != 0)
        return fail("signal escaped to worker thread");
    if (pthread_sigmask(SIG_UNBLOCK, &set, NULL) != 0)
        return fail("main signal unblock");
    (void)syscall(SYS_getpid);
    if (pthread_join(thread, NULL) != 0)
        return fail("observer pthread_join");
    if (sigxfsz_count != 1)
        return fail("signal did not return to main thread");

    close(wake_pipe[0]);
    close(wake_pipe[1]);
    close(thread_fd);
    return 0;
}

int main(void)
{
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_sigxfsz;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGXFSZ, &action, NULL) != 0)
        return fail("sigaction");
    if (sigaction(SIGPIPE, &action, NULL) != 0)
        return fail("sigpipe sigaction");

    if (test_scalar_and_large_writes() != 0 ||
        test_vectors_and_large_limit() != 0 ||
        test_memfd_truncate_and_nonfiles() != 0 ||
        test_sigxfsz_targets_calling_thread() != 0)
        return 1;

    puts("RLIMIT_FSIZE_PASS");
    return 0;
}
