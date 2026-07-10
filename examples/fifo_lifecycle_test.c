#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static const char rendezvous_path[] = "/tmp/kandelo-fifo-rendezvous";
static const char cancel_path[] = "/tmp/kandelo-fifo-cancel";
static const char pre_cancel_path[] = "/tmp/kandelo-fifo-pre-cancel";
static const char disabled_cancel_path[] = "/tmp/kandelo-fifo-disabled-cancel";
static const char signal_cancel_path[] = "/tmp/kandelo-fifo-signal-cancel";
static const char path_only_path[] = "/tmp/kandelo-fifo-path-only";
static const char path_only_regular_path[] = "/tmp/kandelo-regular-path-only";
static const char futimens_writable_path[] = "/tmp/kandelo-fifo-futimens-writable";
static const char futimens_omit_path[] = "/tmp/kandelo-fifo-futimens-omit";
static const char cached_metadata_path[] = "/tmp/kandelo-fifo-cached-metadata";
static const char rename_source_path[] = "/tmp/kandelo-fifo-rename-source";
static const char rename_destination_path[] =
    "/tmp/kandelo-fifo-rename-destination";
static const char renameat_source_path[] = "/tmp/kandelo-fifo-renameat-source";
static const char renameat_destination_path[] =
    "/tmp/kandelo-fifo-renameat-destination";
static const char payload[] = "fifo-payload";
static volatile sig_atomic_t fifo_signal_count;

static int fail(const char *operation)
{
    fprintf(stderr, "%s: %s\n", operation, strerror(errno));
    return -1;
}

static int write_all(int fd, const void *buffer, size_t size)
{
    const unsigned char *bytes = buffer;
    size_t written = 0;

    while (written < size) {
        ssize_t result = write(fd, bytes + written, size - written);
        if (result < 0 && errno == EINTR)
            continue;
        if (result <= 0)
            return -1;
        written += (size_t)result;
    }
    return 0;
}

static int read_exact(int fd, void *buffer, size_t size)
{
    unsigned char *bytes = buffer;
    size_t used = 0;

    while (used < size) {
        ssize_t result = read(fd, bytes + used, size - used);
        if (result < 0 && errno == EINTR)
            continue;
        if (result <= 0)
            return -1;
        used += (size_t)result;
    }
    return 0;
}

static int timespec_is_after(struct timespec later, struct timespec earlier)
{
    return later.tv_sec > earlier.tv_sec ||
        (later.tv_sec == earlier.tv_sec && later.tv_nsec > earlier.tv_nsec);
}

static int wait_for_timestamp_change(void)
{
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 20000000 };

    while (nanosleep(&delay, &delay) != 0) {
        if (errno != EINTR)
            return -1;
    }
    return 0;
}

static int verify_fifo_metadata(const char *path)
{
    struct stat status;
    if (lstat(path, &status) != 0)
        return fail("lstat FIFO");
    if (!S_ISFIFO(status.st_mode)) {
        fprintf(stderr, "FIFO marker reported mode %#o\n",
            (unsigned)status.st_mode);
        return -1;
    }
    return 0;
}

static int test_process_rendezvous(void)
{
    unlink(rendezvous_path);
    if (mkfifo(rendezvous_path, 0600) != 0)
        return fail("mkfifo rendezvous");
    if (verify_fifo_metadata(rendezvous_path) != 0)
        goto failure;

    errno = 0;
    int writer = open(rendezvous_path, O_WRONLY | O_NONBLOCK);
    if (writer >= 0 || errno != ENXIO) {
        if (writer >= 0)
            close(writer);
        fprintf(stderr, "writer without reader: fd=%d errno=%d\n",
            writer, errno);
        goto failure;
    }

    int gate[2];
    if (pipe(gate) != 0) {
        fail("rendezvous gate");
        goto failure;
    }

    pid_t child = fork();
    if (child < 0) {
        fail("fork rendezvous");
        close(gate[0]);
        close(gate[1]);
        goto failure;
    }
    if (child == 0) {
        close(gate[0]);
        if (write_all(gate[1], "R", 1) != 0)
            _exit(10);
        close(gate[1]);

        int reader = open(rendezvous_path, O_RDONLY);
        if (reader < 0)
            _exit(11);
        char received[sizeof(payload)];
        if (read_exact(reader, received, sizeof(received)) != 0)
            _exit(12);
        if (memcmp(received, payload, sizeof(payload)) != 0)
            _exit(13);
        char extra;
        if (read(reader, &extra, 1) != 0)
            _exit(14);
        close(reader);
        _exit(0);
    }

    close(gate[1]);
    char ready;
    if (read_exact(gate[0], &ready, 1) != 0 || ready != 'R') {
        close(gate[0]);
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
        fprintf(stderr, "reader did not reach the rendezvous\n");
        goto failure;
    }
    close(gate[0]);

    /* Give the child a chance to enter open(). A correct blocking FIFO
     * reader cannot exit before a writer has joined the rendezvous. */
    usleep(20000);
    int early_status = 0;
    pid_t early_child = waitpid(child, &early_status, WNOHANG);
    if (early_child < 0) {
        fail("probe blocked FIFO reader");
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
        goto failure;
    }
    if (early_child == child) {
        fprintf(stderr, "FIFO reader returned before a writer: status=%#x\n",
            early_status);
        goto failure;
    }

    writer = open(rendezvous_path, O_WRONLY);
    if (writer < 0) {
        fail("open FIFO writer");
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
        goto failure;
    }
    if (write_all(writer, payload, sizeof(payload)) != 0) {
        fail("write FIFO payload");
        close(writer);
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
        goto failure;
    }
    close(writer);

    int child_status = 0;
    if (waitpid(child, &child_status, 0) != child ||
        !WIFEXITED(child_status) || WEXITSTATUS(child_status) != 0) {
        fprintf(stderr, "FIFO reader child status=%#x\n", child_status);
        goto failure;
    }
    if (unlink(rendezvous_path) != 0)
        return fail("unlink rendezvous FIFO");

    puts("FIFO_RENDEZVOUS_PASS");
    return 0;

failure:
    unlink(rendezvous_path);
    return -1;
}

struct cancel_context {
    atomic_int entered_open;
    atomic_int cleanup_ran;
    int open_result;
    int open_errno;
};

static void record_cancel_cleanup(void *opaque)
{
    struct cancel_context *context = opaque;
    atomic_store_explicit(&context->cleanup_ran, 1, memory_order_release);
}

static void *blocked_fifo_reader(void *opaque)
{
    struct cancel_context *context = opaque;

    pthread_cleanup_push(record_cancel_cleanup, context);
    atomic_store_explicit(&context->entered_open, 1, memory_order_release);
    errno = 0;
    context->open_result = open(cancel_path, O_RDONLY);
    context->open_errno = errno;
    if (context->open_result >= 0)
        close(context->open_result);
    pthread_cleanup_pop(0);
    return NULL;
}

static int test_blocked_open_cancellation(void)
{
    unlink(cancel_path);
    if (mkfifo(cancel_path, 0600) != 0)
        return fail("mkfifo cancel");

    struct cancel_context context = {
        .open_result = -2,
        .open_errno = 0,
    };
    atomic_init(&context.entered_open, 0);
    atomic_init(&context.cleanup_ran, 0);
    pthread_t thread;
    int error = pthread_create(&thread, NULL, blocked_fifo_reader, &context);
    if (error != 0) {
        errno = error;
        fail("pthread_create FIFO reader");
        goto failure;
    }

    while (!atomic_load_explicit(&context.entered_open, memory_order_acquire))
        usleep(1000);
    usleep(50000);

    error = pthread_cancel(thread);
    if (error != 0) {
        errno = error;
        fail("pthread_cancel FIFO reader");
        goto failure;
    }

    void *joined = NULL;
    error = pthread_join(thread, &joined);
    if (error != 0) {
        errno = error;
        fail("pthread_join FIFO reader");
        goto failure;
    }
    if (joined != PTHREAD_CANCELED ||
        !atomic_load_explicit(&context.cleanup_ran, memory_order_acquire)) {
        fprintf(stderr,
            "blocked FIFO cancellation mismatch: joined=%p cleanup=%d "
            "open_result=%d open_errno=%d\n",
            joined,
            atomic_load_explicit(&context.cleanup_ran, memory_order_relaxed),
            context.open_result, context.open_errno);
        goto failure;
    }

    errno = 0;
    int writer = open(cancel_path, O_WRONLY | O_NONBLOCK);
    if (writer >= 0 || errno != ENXIO) {
        if (writer >= 0)
            close(writer);
        fprintf(stderr,
            "canceled FIFO reader leaked a reservation: fd=%d errno=%d\n",
            writer, errno);
        goto failure;
    }

    if (unlink(cancel_path) != 0)
        return fail("unlink cancel FIFO");

    puts("FIFO_ENQUEUED_CANCEL_PASS");
    return 0;

failure:
    unlink(cancel_path);
    return -1;
}

struct pre_cancel_context {
    const char *path;
    atomic_int ready;
    atomic_int release;
    atomic_int entered_open;
    atomic_int open_returned;
    atomic_int cleanup_ran;
    int open_result;
    int open_errno;
};

static void record_pre_cancel_cleanup(void *opaque)
{
    struct pre_cancel_context *context = opaque;
    atomic_store_explicit(&context->cleanup_ran, 1, memory_order_release);
}

static void *pre_canceled_fifo_reader(void *opaque)
{
    struct pre_cancel_context *context = opaque;
    int previous_state = PTHREAD_CANCEL_ENABLE;

    if (pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &previous_state) != 0)
        return (void *)1;

    pthread_cleanup_push(record_pre_cancel_cleanup, context);
    atomic_store_explicit(&context->ready, 1, memory_order_release);
    while (!atomic_load_explicit(&context->release, memory_order_acquire))
        atomic_signal_fence(memory_order_seq_cst);

    atomic_store_explicit(&context->entered_open, 1, memory_order_release);
    errno = 0;
    context->open_result = open(context->path, O_RDONLY);
    context->open_errno = errno;
    atomic_store_explicit(&context->open_returned, 1, memory_order_release);
    if (context->open_result >= 0)
        close(context->open_result);

    pthread_setcancelstate(previous_state, NULL);
    pthread_testcancel();
    pthread_cleanup_pop(0);
    return NULL;
}

static int test_pre_enqueue_open_cancellation(void)
{
    unlink(pre_cancel_path);
    if (mkfifo(pre_cancel_path, 0600) != 0)
        return fail("mkfifo pre-cancel");

    struct pre_cancel_context context = {
        .path = pre_cancel_path,
        .open_result = -2,
        .open_errno = 0,
    };
    atomic_init(&context.ready, 0);
    atomic_init(&context.release, 0);
    atomic_init(&context.entered_open, 0);
    atomic_init(&context.open_returned, 0);
    atomic_init(&context.cleanup_ran, 0);

    pthread_t thread;
    int error = pthread_create(&thread, NULL, pre_canceled_fifo_reader,
        &context);
    if (error != 0) {
        errno = error;
        fail("pthread_create pre-canceled FIFO reader");
        goto failure;
    }

    while (!atomic_load_explicit(&context.ready, memory_order_acquire))
        usleep(1000);

    /* pthread_cancel does not return until the kernel worker has recorded the
     * pending request. The target cannot submit open() until release is set,
     * so this deterministically exercises cancel-before-retry-registration. */
    error = pthread_cancel(thread);
    if (error != 0) {
        errno = error;
        fail("pthread_cancel pre-canceled FIFO reader");
        atomic_store_explicit(&context.release, 1, memory_order_release);
        goto failure;
    }
    atomic_store_explicit(&context.release, 1, memory_order_release);

    while (!atomic_load_explicit(&context.entered_open, memory_order_acquire))
        usleep(1000);
    usleep(50000);
    if (atomic_load_explicit(&context.open_returned, memory_order_acquire)) {
        fprintf(stderr,
            "cancellation-disabled FIFO open returned before a writer: "
            "result=%d errno=%d\n",
            context.open_result, context.open_errno);
        goto failure;
    }

    int admitted_writer = open(pre_cancel_path, O_WRONLY);
    if (admitted_writer < 0) {
        fail("admit writer for pre-canceled FIFO reader");
        goto failure;
    }
    close(admitted_writer);

    void *joined = NULL;
    error = pthread_join(thread, &joined);
    if (error != 0) {
        errno = error;
        fail("pthread_join pre-canceled FIFO reader");
        goto failure;
    }
    if (joined != PTHREAD_CANCELED ||
        !atomic_load_explicit(&context.open_returned, memory_order_acquire) ||
        !atomic_load_explicit(&context.cleanup_ran, memory_order_acquire) ||
        context.open_result < 0 || context.open_errno != 0) {
        fprintf(stderr,
            "pre-enqueue FIFO cancellation mismatch: joined=%p returned=%d "
            "cleanup=%d open_result=%d open_errno=%d\n",
            joined,
            atomic_load_explicit(&context.open_returned,
                memory_order_relaxed),
            atomic_load_explicit(&context.cleanup_ran, memory_order_relaxed),
            context.open_result, context.open_errno);
        goto failure;
    }

    errno = 0;
    int writer = open(pre_cancel_path, O_WRONLY | O_NONBLOCK);
    if (writer >= 0 || errno != ENXIO) {
        if (writer >= 0)
            close(writer);
        fprintf(stderr,
            "pre-canceled FIFO reader leaked a reservation: fd=%d errno=%d\n",
            writer, errno);
        goto failure;
    }

    if (unlink(pre_cancel_path) != 0)
        return fail("unlink pre-cancel FIFO");

    puts("FIFO_PRE_ENQUEUE_CANCEL_PASS");
    return 0;

failure:
    unlink(pre_cancel_path);
    return -1;
}

static int test_disabled_blocked_open_cancellation(void)
{
    unlink(disabled_cancel_path);
    if (mkfifo(disabled_cancel_path, 0600) != 0)
        return fail("mkfifo disabled-cancel");

    struct pre_cancel_context context = {
        .path = disabled_cancel_path,
        .open_result = -2,
        .open_errno = 0,
    };
    atomic_init(&context.ready, 0);
    atomic_init(&context.release, 0);
    atomic_init(&context.entered_open, 0);
    atomic_init(&context.open_returned, 0);
    atomic_init(&context.cleanup_ran, 0);

    pthread_t thread;
    int error = pthread_create(&thread, NULL, pre_canceled_fifo_reader,
        &context);
    if (error != 0) {
        errno = error;
        fail("pthread_create disabled-cancel FIFO reader");
        goto failure;
    }
    while (!atomic_load_explicit(&context.ready, memory_order_acquire))
        usleep(1000);

    atomic_store_explicit(&context.release, 1, memory_order_release);
    while (!atomic_load_explicit(&context.entered_open, memory_order_acquire))
        usleep(1000);
    usleep(50000);
    if (atomic_load_explicit(&context.open_returned, memory_order_acquire)) {
        fprintf(stderr,
            "cancellation-disabled FIFO open returned before cancellation: "
            "result=%d errno=%d\n",
            context.open_result, context.open_errno);
        goto failure;
    }

    /* This request wakes the already deferred open with EINTR. Cancellation
     * is disabled, so libc must re-establish the FIFO waiter instead of
     * returning to the application or consuming the pending request. */
    error = pthread_cancel(thread);
    if (error != 0) {
        errno = error;
        fail("pthread_cancel disabled-cancel FIFO reader");
        goto failure;
    }
    usleep(50000);
    if (atomic_load_explicit(&context.open_returned, memory_order_acquire)) {
        fprintf(stderr,
            "cancellation-disabled FIFO open returned after cancellation: "
            "result=%d errno=%d\n",
            context.open_result, context.open_errno);
        goto failure;
    }

    int admitted_writer = open(disabled_cancel_path, O_WRONLY);
    if (admitted_writer < 0) {
        fail("admit writer for disabled-cancel FIFO reader");
        goto failure;
    }
    close(admitted_writer);

    void *joined = NULL;
    error = pthread_join(thread, &joined);
    if (error != 0) {
        errno = error;
        fail("pthread_join disabled-cancel FIFO reader");
        goto failure;
    }
    if (joined != PTHREAD_CANCELED ||
        !atomic_load_explicit(&context.open_returned, memory_order_acquire) ||
        !atomic_load_explicit(&context.cleanup_ran, memory_order_acquire) ||
        context.open_result < 0 || context.open_errno != 0) {
        fprintf(stderr,
            "disabled-cancel FIFO mismatch: joined=%p returned=%d "
            "cleanup=%d open_result=%d open_errno=%d\n",
            joined,
            atomic_load_explicit(&context.open_returned,
                memory_order_relaxed),
            atomic_load_explicit(&context.cleanup_ran, memory_order_relaxed),
            context.open_result, context.open_errno);
        goto failure;
    }

    errno = 0;
    int writer = open(disabled_cancel_path, O_WRONLY | O_NONBLOCK);
    if (writer >= 0 || errno != ENXIO) {
        if (writer >= 0)
            close(writer);
        fprintf(stderr,
            "disabled-cancel FIFO reader leaked a reservation: "
            "fd=%d errno=%d\n", writer, errno);
        goto failure;
    }
    if (unlink(disabled_cancel_path) != 0)
        return fail("unlink disabled-cancel FIFO");

    puts("FIFO_DISABLED_CANCEL_PASS");
    return 0;

failure:
    unlink(disabled_cancel_path);
    return -1;
}

static void record_fifo_signal(int signum)
{
    if (signum == SIGUSR1)
        fifo_signal_count++;
}

static int test_signal_eintr_with_disabled_pending_cancel(void)
{
    unlink(signal_cancel_path);
    if (mkfifo(signal_cancel_path, 0600) != 0)
        return fail("mkfifo signal-cancel");

    struct sigaction action;
    struct sigaction previous;
    memset(&action, 0, sizeof(action));
    action.sa_handler = record_fifo_signal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR1, &action, &previous) != 0)
        goto failure;
    fifo_signal_count = 0;

    struct pre_cancel_context context = {
        .path = signal_cancel_path,
        .open_result = -2,
        .open_errno = 0,
    };
    atomic_init(&context.ready, 0);
    atomic_init(&context.release, 0);
    atomic_init(&context.entered_open, 0);
    atomic_init(&context.open_returned, 0);
    atomic_init(&context.cleanup_ran, 0);

    pthread_t thread;
    int error = pthread_create(&thread, NULL, pre_canceled_fifo_reader,
        &context);
    if (error != 0) {
        errno = error;
        fail("pthread_create signal-cancel FIFO reader");
        goto restore;
    }
    while (!atomic_load_explicit(&context.ready, memory_order_acquire))
        usleep(1000);

    error = pthread_cancel(thread);
    if (error != 0) {
        errno = error;
        fail("pthread_cancel signal-cancel FIFO reader");
        atomic_store_explicit(&context.release, 1, memory_order_release);
        goto restore;
    }
    atomic_store_explicit(&context.release, 1, memory_order_release);
    while (!atomic_load_explicit(&context.entered_open, memory_order_acquire))
        usleep(1000);
    usleep(50000);

    error = pthread_kill(thread, SIGUSR1);
    if (error != 0) {
        errno = error;
        fail("pthread_kill signal-cancel FIFO reader");
        goto restore;
    }

    void *joined = NULL;
    error = pthread_join(thread, &joined);
    if (error != 0) {
        errno = error;
        fail("pthread_join signal-cancel FIFO reader");
        goto restore;
    }
    if (sigaction(SIGUSR1, &previous, NULL) != 0)
        goto failure;
    if (joined != PTHREAD_CANCELED || fifo_signal_count != 1 ||
        !atomic_load_explicit(&context.open_returned, memory_order_acquire) ||
        !atomic_load_explicit(&context.cleanup_ran, memory_order_acquire) ||
        context.open_result != -1 || context.open_errno != EINTR) {
        fprintf(stderr,
            "signal/cancel FIFO mismatch: joined=%p signals=%d returned=%d "
            "cleanup=%d open_result=%d open_errno=%d\n",
            joined, (int)fifo_signal_count,
            atomic_load_explicit(&context.open_returned,
                memory_order_relaxed),
            atomic_load_explicit(&context.cleanup_ran, memory_order_relaxed),
            context.open_result, context.open_errno);
        goto failure;
    }

    errno = 0;
    int writer = open(signal_cancel_path, O_WRONLY | O_NONBLOCK);
    if (writer >= 0 || errno != ENXIO) {
        if (writer >= 0)
            close(writer);
        fprintf(stderr,
            "signal-interrupted FIFO reader leaked a reservation: "
            "fd=%d errno=%d\n", writer, errno);
        goto failure;
    }
    if (unlink(signal_cancel_path) != 0)
        return fail("unlink signal-cancel FIFO");

    puts("FIFO_SIGNAL_EINTR_PASS");
    return 0;

restore:
    sigaction(SIGUSR1, &previous, NULL);
failure:
    unlink(signal_cancel_path);
    return -1;
}

static int verify_path_only_direct_operations(int fd, const char *kind)
{
    char byte = 0;
    int enabled = 1;
    struct iovec iovec = { .iov_base = &byte, .iov_len = 1 };
    struct timespec requested_times[2] = {
        { .tv_sec = 1, .tv_nsec = 2 },
        { .tv_sec = 3, .tv_nsec = 4 },
    };

#define EXPECT_EBADF(operation, expression)                                  \
    do {                                                                      \
        errno = 0;                                                            \
        long result = (long)(expression);                                     \
        if (result != -1 || errno != EBADF) {                                 \
            fprintf(stderr, "%s O_SEARCH %s: result=%ld errno=%d\n",         \
                kind, operation, result, errno);                              \
            return -1;                                                        \
        }                                                                     \
    } while (0)

    EXPECT_EBADF("read", read(fd, &byte, 1));
    EXPECT_EBADF("write", write(fd, &byte, 1));
    EXPECT_EBADF("pread", pread(fd, &byte, 1, 0));
    EXPECT_EBADF("pwrite", pwrite(fd, &byte, 1, 0));
    EXPECT_EBADF("readv", readv(fd, &iovec, 1));
    EXPECT_EBADF("writev", writev(fd, &iovec, 1));
    EXPECT_EBADF("preadv", preadv(fd, &iovec, 1, 0));
    EXPECT_EBADF("pwritev", pwritev(fd, &iovec, 1, 0));
    EXPECT_EBADF("lseek", lseek(fd, 0, SEEK_SET));
    EXPECT_EBADF("ftruncate", ftruncate(fd, 0));
    EXPECT_EBADF("fallocate", fallocate(fd, 0, 0, 1));
    EXPECT_EBADF("fsync", fsync(fd));
    EXPECT_EBADF("fdatasync", fdatasync(fd));
    EXPECT_EBADF("fcntl F_SETFL", fcntl(fd, F_SETFL, O_NONBLOCK));
    EXPECT_EBADF("fcntl F_SETOWN", fcntl(fd, F_SETOWN, 1));
    EXPECT_EBADF("fcntl F_GETOWN", syscall(SYS_fcntl, fd, F_GETOWN, 0));
    EXPECT_EBADF("flock", flock(fd, LOCK_EX | LOCK_NB));
    EXPECT_EBADF("ioctl FIONBIO", ioctl(fd, FIONBIO, &enabled));
    EXPECT_EBADF("ioctl FIONREAD", ioctl(fd, FIONREAD, &enabled));
    EXPECT_EBADF("fchmod", fchmod(fd, 0600));
    EXPECT_EBADF("fchown", fchown(fd, (uid_t)-1, (gid_t)-1));
    EXPECT_EBADF("futimens", futimens(fd, requested_times));

    errno = 0;
    void *mapping = mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, fd, 0);
    if (mapping != MAP_FAILED || errno != EBADF) {
        fprintf(stderr, "%s O_SEARCH mmap: result=%p errno=%d\n",
            kind, mapping, errno);
        if (mapping != MAP_FAILED)
            munmap(mapping, 4096);
        return -1;
    }

    int status_flags = fcntl(fd, F_GETFL);
    if (status_flags < 0 || !(status_flags & O_PATH)) {
        fprintf(stderr, "%s O_SEARCH F_GETFL: flags=%#x errno=%d\n",
            kind, status_flags, errno);
        return -1;
    }
    int descriptor_flags = fcntl(fd, F_GETFD);
    if (descriptor_flags < 0 ||
        fcntl(fd, F_SETFD, descriptor_flags | FD_CLOEXEC) != 0) {
        fprintf(stderr, "%s O_SEARCH descriptor flags: errno=%d\n",
            kind, errno);
        return -1;
    }
    if (ioctl(fd, FIOCLEX) != 0) {
        fprintf(stderr, "%s O_SEARCH FIOCLEX: errno=%d\n", kind, errno);
        return -1;
    }
    int duplicate = dup(fd);
    if (duplicate < 0) {
        fprintf(stderr, "%s O_SEARCH dup: errno=%d\n", kind, errno);
        return -1;
    }
    close(duplicate);

    struct pollfd poll_descriptor = {
        .fd = fd,
        .events = POLLIN | POLLOUT,
    };
    if (poll(&poll_descriptor, 1, 0) != 1 ||
        poll_descriptor.revents != POLLNVAL) {
        fprintf(stderr, "%s O_SEARCH poll: revents=%#x errno=%d\n",
            kind, poll_descriptor.revents, errno);
        return -1;
    }

#undef EXPECT_EBADF
    return 0;
}

static int test_path_only_open(void)
{
    unlink(path_only_path);
    unlink(path_only_regular_path);
    if (mkfifo(path_only_path, 0000) != 0)
        return fail("mkfifo path-only");

    int fd = open(path_only_path, O_SEARCH | O_CLOEXEC);
    if (fd < 0) {
        fail("open FIFO O_SEARCH");
        goto failure;
    }
    struct stat status;
    if (fstat(fd, &status) != 0 || !S_ISFIFO(status.st_mode)) {
        fprintf(stderr, "O_SEARCH FIFO fstat mismatch\n");
        close(fd);
        goto failure;
    }
    if (verify_path_only_direct_operations(fd, "FIFO") != 0) {
        close(fd);
        goto failure;
    }

    struct timespec linked_ctime = status.st_ctim;
    struct timespec ctime_delay = { .tv_sec = 0, .tv_nsec = 20000000 };
    if (nanosleep(&ctime_delay, NULL) != 0) {
        fail("wait before FIFO unlink ctime check");
        close(fd);
        goto failure;
    }
    if (unlink(path_only_path) != 0) {
        fail("unlink open O_SEARCH FIFO");
        close(fd);
        return -1;
    }
    if (fstat(fd, &status) != 0 || status.st_nlink != 0) {
        fprintf(stderr, "unlinked O_SEARCH FIFO fstat mismatch\n");
        close(fd);
        return -1;
    }
    if (status.st_ctim.tv_sec < linked_ctime.tv_sec ||
        (status.st_ctim.tv_sec == linked_ctime.tv_sec &&
         status.st_ctim.tv_nsec <= linked_ctime.tv_nsec)) {
        fprintf(stderr,
            "final FIFO unlink did not advance ctime: before=%lld.%09ld "
            "after=%lld.%09ld\n",
            (long long)linked_ctime.tv_sec, linked_ctime.tv_nsec,
            (long long)status.st_ctim.tv_sec, status.st_ctim.tv_nsec);
        close(fd);
        return -1;
    }
    close(fd);

    if (mkfifo(path_only_path, 0000) != 0)
        return fail("recreate path-only FIFO");
    fd = openat(AT_FDCWD, path_only_path, O_SEARCH | O_CLOEXEC);
    if (fd < 0) {
        fail("openat FIFO O_SEARCH");
        goto failure;
    }
    close(fd);
    if (unlink(path_only_path) != 0)
        return fail("unlink path-only FIFO");

    fd = open(path_only_regular_path,
        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (fd < 0)
        goto failure;
    close(fd);
    fd = open(path_only_regular_path, O_SEARCH | O_CLOEXEC);
    if (fd < 0) {
        fail("open regular file O_SEARCH");
        goto failure;
    }
    if (fstat(fd, &status) != 0 || !S_ISREG(status.st_mode)) {
        fprintf(stderr, "O_SEARCH regular-file fstat mismatch\n");
        close(fd);
        goto failure;
    }
    if (verify_path_only_direct_operations(fd, "regular file") != 0) {
        close(fd);
        goto failure;
    }
    close(fd);
    if (unlink(path_only_regular_path) != 0)
        return fail("unlink regular path-only file");

    puts("FIFO_PATH_ONLY_PASS");
    return 0;

failure:
    unlink(path_only_path);
    unlink(path_only_regular_path);
    return -1;
}

static int test_fifo_futimens_permissions(void)
{
    int writable_fd = -1;
    int omit_fd = -1;
    int status = 0;
    unlink(futimens_writable_path);
    unlink(futimens_omit_path);

    if (mkfifo(futimens_writable_path, 0600) != 0 ||
        chmod(futimens_writable_path, 0666) != 0)
        goto failure;
    writable_fd = open(futimens_writable_path, O_RDWR | O_CLOEXEC);
    if (writable_fd < 0)
        goto failure;

    if (mkfifo(futimens_omit_path, 0000) != 0)
        goto failure;
    omit_fd = open(futimens_omit_path, O_RDWR | O_CLOEXEC);
    if (omit_fd < 0)
        goto failure;

    pid_t child = fork();
    if (child < 0)
        goto failure;
    if (child == 0) {
        struct timespec explicit_times[2] = {
            { .tv_sec = 11, .tv_nsec = 12 },
            { .tv_sec = 21, .tv_nsec = 22 },
        };
        struct timespec omitted_times[2] = {
            { .tv_sec = -1, .tv_nsec = UTIME_OMIT },
            { .tv_sec = -1, .tv_nsec = UTIME_OMIT },
        };
        struct stat before;
        struct stat after;

        if (seteuid(1000) != 0)
            _exit(20);
        if (futimens(writable_fd, NULL) != 0)
            _exit(21);
        errno = 0;
        if (futimens(writable_fd, explicit_times) != -1 || errno != EPERM)
            _exit(22);
        if (fstat(omit_fd, &before) != 0 ||
            futimens(omit_fd, omitted_times) != 0 ||
            fstat(omit_fd, &after) != 0)
            _exit(23);
        if (before.st_atim.tv_sec != after.st_atim.tv_sec ||
            before.st_atim.tv_nsec != after.st_atim.tv_nsec ||
            before.st_mtim.tv_sec != after.st_mtim.tv_sec ||
            before.st_mtim.tv_nsec != after.st_mtim.tv_nsec ||
            before.st_ctim.tv_sec != after.st_ctim.tv_sec ||
            before.st_ctim.tv_nsec != after.st_ctim.tv_nsec)
            _exit(24);
        _exit(0);
    }

    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) ||
        WEXITSTATUS(status) != 0) {
        fprintf(stderr, "FIFO futimens permission child status=%#x\n", status);
        errno = EIO;
        goto failure;
    }

    close(omit_fd);
    close(writable_fd);
    unlink(futimens_omit_path);
    unlink(futimens_writable_path);
    puts("FIFO_FUTIMENS_PERMISSIONS_PASS");
    return 0;

failure: {
        int saved_errno = errno;
        if (omit_fd >= 0)
            close(omit_fd);
        if (writable_fd >= 0)
            close(writable_fd);
        unlink(futimens_omit_path);
        unlink(futimens_writable_path);
        errno = saved_errno;
        return fail("FIFO futimens permissions");
    }
}

static int test_cached_metadata_ctime(void)
{
    const char *paths[] = {
        cached_metadata_path,
        rename_source_path,
        rename_destination_path,
        renameat_source_path,
        renameat_destination_path,
    };
    int fd = -1;
    struct stat status;
    struct timespec before;

    for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); i++)
        unlink(paths[i]);

    if (mkfifo(cached_metadata_path, 0600) != 0)
        goto failure;
    fd = open(cached_metadata_path, O_RDWR | O_CLOEXEC);
    if (fd < 0)
        goto failure;
    if (unlink(cached_metadata_path) != 0 || fstat(fd, &status) != 0 ||
        status.st_nlink != 0)
        goto failure;

    before = status.st_ctim;
    if (wait_for_timestamp_change() != 0 || fchmod(fd, 0620) != 0 ||
        fstat(fd, &status) != 0)
        goto failure;
    if ((status.st_mode & 0777) != 0620 ||
        !timespec_is_after(status.st_ctim, before)) {
        fprintf(stderr, "unlinked FIFO fchmod did not advance ctime\n");
        errno = EIO;
        goto failure;
    }

    before = status.st_ctim;
    if (wait_for_timestamp_change() != 0 ||
        fchown(fd, (uid_t)-1, (gid_t)-1) != 0 ||
        fstat(fd, &status) != 0)
        goto failure;
    if (!timespec_is_after(status.st_ctim, before)) {
        fprintf(stderr, "unlinked FIFO fchown did not advance ctime\n");
        errno = EIO;
        goto failure;
    }
    close(fd);
    fd = -1;

    fd = open(rename_source_path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0)
        goto failure;
    close(fd);
    fd = -1;
    if (mkfifo(rename_destination_path, 0600) != 0)
        goto failure;
    fd = open(rename_destination_path, O_RDWR | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &status) != 0)
        goto failure;
    before = status.st_ctim;
    if (wait_for_timestamp_change() != 0 ||
        rename(rename_source_path, rename_destination_path) != 0 ||
        fstat(fd, &status) != 0)
        goto failure;
    if (status.st_nlink != 0 || !timespec_is_after(status.st_ctim, before)) {
        fprintf(stderr, "rename-over FIFO did not advance cached ctime\n");
        errno = EIO;
        goto failure;
    }
    close(fd);
    fd = -1;
    if (unlink(rename_destination_path) != 0)
        goto failure;

    fd = open(renameat_source_path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0)
        goto failure;
    close(fd);
    fd = -1;
    if (mkfifo(renameat_destination_path, 0600) != 0)
        goto failure;
    fd = open(renameat_destination_path, O_RDWR | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &status) != 0)
        goto failure;
    before = status.st_ctim;
    if (wait_for_timestamp_change() != 0 ||
        renameat(AT_FDCWD, renameat_source_path, AT_FDCWD,
            renameat_destination_path) != 0 ||
        fstat(fd, &status) != 0)
        goto failure;
    if (status.st_nlink != 0 || !timespec_is_after(status.st_ctim, before)) {
        fprintf(stderr, "renameat-over FIFO did not advance cached ctime\n");
        errno = EIO;
        goto failure;
    }
    close(fd);
    fd = -1;
    if (unlink(renameat_destination_path) != 0)
        goto failure;

    puts("FIFO_CACHED_CTIME_PASS");
    return 0;

failure: {
        int saved_errno = errno;
        if (fd >= 0)
            close(fd);
        for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); i++)
            unlink(paths[i]);
        errno = saved_errno;
        return fail("cached FIFO ctime lifecycle");
    }
}

int main(void)
{
    if (test_process_rendezvous() != 0)
        return 1;
    if (test_blocked_open_cancellation() != 0)
        return 2;
    if (test_pre_enqueue_open_cancellation() != 0)
        return 3;
    if (test_disabled_blocked_open_cancellation() != 0)
        return 4;
    if (test_signal_eintr_with_disabled_pending_cancel() != 0)
        return 5;
    if (test_path_only_open() != 0)
        return 6;
    if (test_fifo_futimens_permissions() != 0)
        return 7;
    if (test_cached_metadata_ctime() != 0)
        return 8;

    puts("FIFO_CANCEL_PASS");
    puts("FIFO_LIFECYCLE_PASS");
    return 0;
}
