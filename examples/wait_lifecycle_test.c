#define _GNU_SOURCE

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
extern long __syscall_cp_check(long result);

static int fail(const char *step)
{
    fprintf(stderr, "%s: errno=%d (%s)\n", step, errno, strerror(errno));
    return -1;
}

static volatile sig_atomic_t sigchld_count;
static volatile sig_atomic_t sigusr1_count;
static volatile sig_atomic_t sigcont_count;
static volatile sig_atomic_t siginfo_signo;
static volatile sig_atomic_t siginfo_pid;
static volatile sig_atomic_t siginfo_uid;
static volatile sig_atomic_t cancel_enable_error;

static void count_sigchld(int signum)
{
    (void)signum;
    sigchld_count++;
}

static void count_sigusr1(int signum)
{
    (void)signum;
    sigusr1_count++;
}

static void count_sigcont(int signum)
{
    (void)signum;
    sigcont_count++;
}

static void capture_siginfo(int signum, siginfo_t *info, void *ucontext)
{
    (void)ucontext;
    siginfo_signo = signum;
    siginfo_pid = info->si_pid;
    siginfo_uid = info->si_uid;
}

static void enable_pending_cancel(int signum)
{
    (void)signum;
    int error = pthread_setcancelstate(PTHREAD_CANCEL_ENABLE, NULL);
    if (error != 0)
        cancel_enable_error = error;
}

struct completed_cancel_ctx {
    atomic_int ready;
    atomic_int proceed;
    atomic_int preserved_success;
    atomic_int returned_from_eintr;
    atomic_int cleanup_ran;
};

static void record_completed_cancel_cleanup(void *opaque)
{
    struct completed_cancel_ctx *ctx = opaque;
    atomic_store_explicit(&ctx->cleanup_ran, 1, memory_order_release);
}

static void *completed_cancel_thread(void *opaque)
{
    struct completed_cancel_ctx *ctx = opaque;

    pthread_cleanup_push(record_completed_cancel_cleanup, ctx);
    atomic_store_explicit(&ctx->ready, 1, memory_order_release);
    while (!atomic_load_explicit(&ctx->proceed, memory_order_acquire)) {
        /* Stay outside cancellation points until the caller sets cancel. */
    }

    /* This models the post-dispatch edge of a cancellation-point syscall.
     * Once the syscall completed successfully, cancellation must remain
     * pending instead of replacing a result whose side effects are visible. */
    if (__syscall_cp_check(17) == 17) {
        atomic_store_explicit(
            &ctx->preserved_success,
            1,
            memory_order_release
        );
    }

    /* Host-interrupted cancellation points complete with EINTR. That is the
     * post-dispatch edge where deferred cancellation must take effect. */
    (void)__syscall_cp_check(-EINTR);
    atomic_store_explicit(
        &ctx->returned_from_eintr,
        1,
        memory_order_release
    );
    pthread_cleanup_pop(0);
    return NULL;
}

static int test_cancel_preserves_completed_syscall(void)
{
    struct completed_cancel_ctx ctx = {
        .ready = ATOMIC_VAR_INIT(0),
        .proceed = ATOMIC_VAR_INIT(0),
        .preserved_success = ATOMIC_VAR_INIT(0),
        .returned_from_eintr = ATOMIC_VAR_INIT(0),
        .cleanup_ran = ATOMIC_VAR_INIT(0),
    };
    pthread_t thread;
    int error = pthread_create(&thread, NULL, completed_cancel_thread, &ctx);
    if (error != 0) {
        errno = error;
        return fail("completed-cancel pthread_create");
    }

    while (!atomic_load_explicit(&ctx.ready, memory_order_acquire))
        usleep(1000);
    error = pthread_cancel(thread);
    if (error != 0) {
        errno = error;
        return fail("completed-cancel pthread_cancel");
    }
    atomic_store_explicit(&ctx.proceed, 1, memory_order_release);

    void *joined = NULL;
    error = pthread_join(thread, &joined);
    if (error != 0) {
        errno = error;
        return fail("completed-cancel pthread_join");
    }
    if (joined != PTHREAD_CANCELED ||
        !atomic_load_explicit(&ctx.preserved_success, memory_order_acquire) ||
        atomic_load_explicit(&ctx.returned_from_eintr, memory_order_acquire) ||
        !atomic_load_explicit(&ctx.cleanup_ran, memory_order_acquire)) {
        fprintf(stderr,
            "completed syscall cancellation mismatch: joined=%p "
            "preserved=%d returned_eintr=%d cleanup=%d\n",
            joined,
            atomic_load_explicit(
                &ctx.preserved_success,
                memory_order_relaxed
            ),
            atomic_load_explicit(
                &ctx.returned_from_eintr,
                memory_order_relaxed
            ),
            atomic_load_explicit(&ctx.cleanup_ran, memory_order_relaxed));
        return -1;
    }
    return 0;
}

static int read_all(const char *path, char *buf, size_t size)
{
    FILE *fp = fopen(path, "r");
    if (fp == NULL)
        return fail(path);
    size_t used = fread(buf, 1, size - 1, fp);
    if (ferror(fp)) {
        fclose(fp);
        return fail(path);
    }
    buf[used] = '\0';
    fclose(fp);
    return 0;
}

static int expect_proc_stopped(pid_t pid)
{
    char path[64];
    char buf[1024];

    snprintf(path, sizeof(path), "/proc/%d/stat", (int)pid);
    if (read_all(path, buf, sizeof(buf)) != 0)
        return -1;
    char *end_name = strrchr(buf, ')');
    if (end_name == NULL || end_name[1] != ' ' || end_name[2] != 'T') {
        fprintf(stderr, "proc stat did not report stopped state: %s\n", buf);
        return -1;
    }

    snprintf(path, sizeof(path), "/proc/%d/status", (int)pid);
    if (read_all(path, buf, sizeof(buf)) != 0)
        return -1;
    if (strstr(buf, "State:\tT (stopped)") == NULL) {
        fprintf(stderr, "proc status did not report stopped state: %s\n", buf);
        return -1;
    }
    return 0;
}

static int expect_zero_rusage(const struct rusage *usage)
{
    const unsigned char *bytes = (const unsigned char *)usage;
    const size_t meaningful = sizeof(long) == 4 ? 88 : 144;

    for (size_t i = 0; i < meaningful; i++) {
        if (bytes[i] != 0) {
            fprintf(stderr, "rusage byte %zu was %u, expected zero\n",
                i, (unsigned)bytes[i]);
            return -1;
        }
    }
    for (size_t i = meaningful; i < sizeof(*usage); i++) {
        if (bytes[i] != 0xa5) {
            fprintf(stderr, "rusage reserved byte %zu was overwritten\n", i);
            return -1;
        }
    }
    return 0;
}

static pid_t spawn_stopping_child(int gate[2], int exit_code)
{
    if (pipe(gate) != 0) {
        fail("pipe");
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        fail("fork");
        return -1;
    }
    if (pid == 0) {
        close(gate[1]);
        struct sigaction cont;
        memset(&cont, 0, sizeof(cont));
        cont.sa_handler = SIG_IGN;
        sigemptyset(&cont.sa_mask);
        if (sigaction(SIGCONT, &cont, NULL) != 0)
            _exit(119);
        if (raise(SIGSTOP) != 0)
            _exit(120);
        char byte = 0;
        if (read(gate[0], &byte, 1) != 1)
            _exit(121);
        close(gate[0]);
        _exit(exit_code);
    }
    close(gate[0]);
    return pid;
}

static int release_child(int fd)
{
    if (write(fd, "x", 1) != 1)
        return fail("release child");
    return close(fd) == 0 ? 0 : fail("close child gate");
}

static int test_wait4_lifecycle(void)
{
    int gate[2];
    pid_t pid = spawn_stopping_child(gate, 42);
    if (pid < 0)
        return -1;

    int status = 0x12345678;
    struct rusage usage;
    errno = 0;
    if (syscall(SYS_wait4, pid, (int *)(uintptr_t)-1, WUNTRACED, NULL) != -1 ||
        errno != EFAULT) {
        fprintf(stderr, "wait4 invalid status did not return EFAULT: errno=%d\n",
            errno);
        return -1;
    }
    errno = 0;
    if (syscall(SYS_wait4, pid, &status, WUNTRACED,
            (struct rusage *)(uintptr_t)-1) != -1 || errno != EFAULT ||
        status != 0x12345678) {
        fprintf(stderr, "wait4 invalid rusage was not transactional: errno=%d\n",
            errno);
        return -1;
    }
    memset(&usage, 0xa5, sizeof(usage));
    pid_t got = wait4(pid, &status, WUNTRACED, &usage);
    if (got != pid || !WIFSTOPPED(status) || WSTOPSIG(status) != SIGSTOP) {
        fprintf(stderr, "wait4 stop mismatch: got=%d status=%#x\n",
            (int)got, status);
        return -1;
    }
    if (expect_zero_rusage(&usage) != 0 || expect_proc_stopped(pid) != 0)
        return -1;

    status = 0x13572468;
    memset(&usage, 0x5a, sizeof(usage));
    struct rusage unchanged = usage;
    got = wait4(pid, &status, WUNTRACED | WNOHANG, &usage);
    if (got != 0 || status != 0x13572468 ||
        memcmp(&usage, &unchanged, sizeof(usage)) != 0) {
        fprintf(stderr, "wait4 no-event call modified caller outputs\n");
        return -1;
    }

    if (kill(pid, SIGCONT) != 0)
        return fail("SIGCONT");
    memset(&usage, 0xa5, sizeof(usage));
    got = wait4(pid, &status, WCONTINUED, &usage);
    if (got != pid || !WIFCONTINUED(status) || expect_zero_rusage(&usage) != 0) {
        fprintf(stderr, "wait4 continue mismatch: got=%d status=%#x\n",
            (int)got, status);
        return -1;
    }

    if (release_child(gate[1]) != 0)
        return -1;
    memset(&usage, 0xa5, sizeof(usage));
    got = wait4(pid, &status, 0, &usage);
    if (got != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 42 ||
        expect_zero_rusage(&usage) != 0) {
        fprintf(stderr, "wait4 exit mismatch: got=%d status=%#x\n",
            (int)got, status);
        return -1;
    }

    errno = 0;
    if (waitpid(pid, &status, WNOHANG | WUNTRACED) != -1 || errno != ECHILD) {
        fprintf(stderr, "post-reap wait did not return ECHILD: errno=%d\n", errno);
        return -1;
    }
    return 0;
}

static int expect_waitid_event(
    pid_t pid,
    int options,
    int expected_code,
    int expected_status,
    int nowait)
{
    siginfo_t info;
    memset(&info, 0x5a, sizeof(info));
    int rc = waitid(P_PID, (id_t)pid, &info, options | (nowait ? WNOWAIT : 0));
    if (rc != 0 || info.si_signo != SIGCHLD || info.si_pid != pid ||
        info.si_code != expected_code || info.si_status != expected_status ||
        info.si_uid != getuid()) {
        fprintf(stderr,
            "waitid mismatch: rc=%d signo=%d pid=%d uid=%u code=%d status=%d\n",
            rc, info.si_signo, (int)info.si_pid, (unsigned)info.si_uid,
            info.si_code, info.si_status);
        return -1;
    }
    return 0;
}

static int test_waitid_lifecycle(void)
{
    int gate[2];
    pid_t pid = spawn_stopping_child(gate, 7);
    if (pid < 0)
        return -1;

    errno = 0;
    if (syscall(SYS_waitid, P_PID, (id_t)pid,
            (siginfo_t *)(uintptr_t)-1, WSTOPPED, NULL) != -1 ||
        errno != EFAULT) {
        fprintf(stderr, "waitid invalid siginfo did not return EFAULT: errno=%d\n",
            errno);
        return -1;
    }
    if (expect_waitid_event(pid, WSTOPPED, CLD_STOPPED, SIGSTOP, 1) != 0 ||
        expect_waitid_event(pid, WSTOPPED, CLD_STOPPED, SIGSTOP, 1) != 0 ||
        expect_waitid_event(pid, WSTOPPED, CLD_STOPPED, SIGSTOP, 0) != 0)
        return -1;

    siginfo_t info;
    memset(&info, 0x5a, sizeof(info));
    if (waitid(P_PID, (id_t)pid, &info, WSTOPPED | WNOHANG) != 0) {
        return fail("waitid WNOHANG");
    }
    const unsigned char *bytes = (const unsigned char *)&info;
    for (size_t i = 0; i < sizeof(info); i++) {
        if (bytes[i] != 0) {
            fprintf(stderr, "waitid WNOHANG left byte %zu nonzero\n", i);
            return -1;
        }
    }

    if (kill(pid, SIGCONT) != 0)
        return fail("waitid SIGCONT");
    if (expect_waitid_event(pid, WCONTINUED, CLD_CONTINUED, SIGCONT, 0) != 0)
        return -1;
    if (release_child(gate[1]) != 0)
        return -1;
    if (expect_waitid_event(pid, WEXITED, CLD_EXITED, 7, 0) != 0)
        return -1;
    return 0;
}

static int test_sigkill_stopped_child(void)
{
    int gate[2];
    pid_t pid = spawn_stopping_child(gate, 0);
    if (pid < 0)
        return -1;

    int status = 0;
    if (waitpid(pid, &status, WUNTRACED) != pid || !WIFSTOPPED(status)) {
        fprintf(stderr, "SIGKILL child did not stop first: status=%#x\n", status);
        return -1;
    }
    if (kill(pid, SIGKILL) != 0)
        return fail("SIGKILL");
    if (waitpid(pid, &status, 0) != pid || !WIFSIGNALED(status) ||
        WTERMSIG(status) != SIGKILL) {
        fprintf(stderr, "SIGKILL child status mismatch: status=%#x\n", status);
        return -1;
    }
    close(gate[1]);
    return 0;
}

static int test_sa_nocldstop(void)
{
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = count_sigchld;
    action.sa_flags = SA_NOCLDSTOP;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL) != 0)
        return fail("sigaction SA_NOCLDSTOP");
    sigchld_count = 0;

    int gate[2];
    pid_t pid = spawn_stopping_child(gate, 9);
    if (pid < 0)
        return -1;
    int status = 0;
    if (waitpid(pid, &status, WUNTRACED) != pid || !WIFSTOPPED(status) ||
        sigchld_count != 0) {
        fprintf(stderr, "SA_NOCLDSTOP stop notification mismatch: count=%d\n",
            (int)sigchld_count);
        return -1;
    }
    if (kill(pid, SIGCONT) != 0)
        return fail("SA_NOCLDSTOP SIGCONT");
    if (waitpid(pid, &status, WCONTINUED) != pid || !WIFCONTINUED(status) ||
        sigchld_count != 0) {
        fprintf(stderr, "SA_NOCLDSTOP continue notification mismatch: count=%d\n",
            (int)sigchld_count);
        return -1;
    }
    if (release_child(gate[1]) != 0)
        return -1;
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) ||
        WEXITSTATUS(status) != 9 || sigchld_count != 1) {
        fprintf(stderr, "SA_NOCLDSTOP exit notification mismatch: status=%#x count=%d\n",
            status, (int)sigchld_count);
        return -1;
    }

    action.sa_handler = SIG_DFL;
    action.sa_flags = 0;
    if (sigaction(SIGCHLD, &action, NULL) != 0)
        return fail("restore SIGCHLD");
    return 0;
}

static int test_getrusage_pointer_validation(void)
{
    errno = 0;
    if (syscall(SYS_getrusage, RUSAGE_SELF, NULL) != -1 || errno != EFAULT) {
        fprintf(stderr, "getrusage NULL did not return EFAULT: errno=%d\n", errno);
        return -1;
    }
    errno = 0;
    if (syscall(SYS_getrusage, RUSAGE_SELF, (void *)(uintptr_t)-1) != -1 ||
        errno != EFAULT) {
        fprintf(stderr, "getrusage invalid range did not return EFAULT: errno=%d\n",
            errno);
        return -1;
    }

    struct rusage usage;
    memset(&usage, 0xa5, sizeof(usage));
    if (getrusage(RUSAGE_SELF, &usage) != 0)
        return fail("getrusage valid");
    return expect_zero_rusage(&usage);
}

static int test_nonmatching_sigchld_interrupts_wait(void)
{
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = count_sigchld;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL) != 0)
        return fail("sigaction interrupting SIGCHLD");
    sigchld_count = 0;

    int gate[2];
    pid_t pid = spawn_stopping_child(gate, 27);
    if (pid < 0)
        return -1;

    int status = 0;
    errno = 0;
    if (waitpid(pid, &status, 0) != -1 || errno != EINTR || sigchld_count != 1) {
        fprintf(stderr,
            "nonmatching stop SIGCHLD did not interrupt wait: errno=%d count=%d\n",
            errno, (int)sigchld_count);
        return -1;
    }

    if (kill(pid, SIGCONT) != 0)
        return fail("interrupt test SIGCONT");
    if (waitpid(pid, &status, WCONTINUED) != pid || !WIFCONTINUED(status)) {
        fprintf(stderr, "interrupt test continue mismatch: status=%#x\n", status);
        return -1;
    }
    if (release_child(gate[1]) != 0)
        return -1;
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) ||
        WEXITSTATUS(status) != 27) {
        fprintf(stderr, "interrupt test exit mismatch: status=%#x\n", status);
        return -1;
    }

    action.sa_handler = SIG_DFL;
    if (sigaction(SIGCHLD, &action, NULL) != 0)
        return fail("restore interrupting SIGCHLD");
    return 0;
}

static int run_wait_restart_case(int restart, int exit_code)
{
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = count_sigusr1;
    action.sa_flags = restart ? SA_RESTART : 0;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR1, &action, NULL) != 0)
        return fail("sigaction SIGUSR1");
    sigusr1_count = 0;

    int gate[2];
    if (pipe(gate) != 0)
        return fail("restart pipe");
    pid_t pid = fork();
    if (pid < 0)
        return fail("restart fork");
    if (pid == 0) {
        close(gate[1]);
        char byte;
        if (read(gate[0], &byte, 1) != 1)
            _exit(121);
        close(gate[0]);
        usleep(20000);
        if (kill(getppid(), SIGUSR1) != 0)
            _exit(122);
        usleep(20000);
        _exit(exit_code);
    }
    close(gate[0]);
    if (release_child(gate[1]) != 0)
        return -1;

    int status = 0;
    errno = 0;
    pid_t got = waitpid(pid, &status, 0);
    if (restart) {
        if (got != pid || !WIFEXITED(status) || WEXITSTATUS(status) != exit_code ||
            sigusr1_count != 1) {
            fprintf(stderr,
                "SA_RESTART wait mismatch: got=%d status=%#x errno=%d count=%d\n",
                (int)got, status, errno, (int)sigusr1_count);
            return -1;
        }
    } else {
        if (got != -1 || errno != EINTR || sigusr1_count != 1) {
            fprintf(stderr,
                "interruptible wait mismatch: got=%d errno=%d count=%d\n",
                (int)got, errno, (int)sigusr1_count);
            return -1;
        }
        if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) ||
            WEXITSTATUS(status) != exit_code) {
            fprintf(stderr, "post-EINTR wait mismatch: status=%#x\n", status);
            return -1;
        }
    }

    action.sa_handler = SIG_DFL;
    action.sa_flags = 0;
    if (sigaction(SIGUSR1, &action, NULL) != 0)
        return fail("restore SIGUSR1");
    return 0;
}

static int test_wait_signal_restart(void)
{
    if (run_wait_restart_case(0, 28) != 0)
        return -1;
    return run_wait_restart_case(1, 29);
}

struct directed_wait_ctx {
    pid_t child;
    atomic_int ready;
    atomic_int done;
    pid_t result;
    int error;
};

static void *directed_wait_thread(void *opaque)
{
    struct directed_wait_ctx *ctx = opaque;
    int status = 0;
    atomic_store_explicit(&ctx->ready, 1, memory_order_release);
    errno = 0;
    ctx->result = waitpid(ctx->child, &status, 0);
    ctx->error = errno;
    atomic_store_explicit(&ctx->done, 1, memory_order_release);
    return NULL;
}

static int test_pthread_kill_interrupts_exact_waiter(void)
{
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = count_sigusr1;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR1, &action, NULL) != 0)
        return fail("directed sigaction");
    sigusr1_count = 0;

    int gate[2];
    if (pipe(gate) != 0)
        return fail("directed pipe");
    pid_t pid = fork();
    if (pid < 0)
        return fail("directed fork");
    if (pid == 0) {
        close(gate[1]);
        char byte;
        if (read(gate[0], &byte, 1) != 1)
            _exit(121);
        close(gate[0]);
        _exit(30);
    }
    close(gate[0]);

    struct directed_wait_ctx ctx = {
        .child = pid,
        .result = 0,
        .error = 0,
    };
    atomic_init(&ctx.ready, 0);
    atomic_init(&ctx.done, 0);
    pthread_t thread;
    if (pthread_create(&thread, NULL, directed_wait_thread, &ctx) != 0)
        return fail("pthread_create directed waiter");
    while (!atomic_load_explicit(&ctx.ready, memory_order_acquire))
        usleep(1000);

    int attempts = 0;
    while (!atomic_load_explicit(&ctx.done, memory_order_acquire) &&
        attempts++ < 5000) {
        int kill_error = pthread_kill(thread, SIGUSR1);
        if (kill_error != 0) {
            if (atomic_load_explicit(&ctx.done, memory_order_acquire))
                break;
            errno = kill_error;
            return fail("pthread_kill directed waiter");
        }
        usleep(1000);
    }
    if (!atomic_load_explicit(&ctx.done, memory_order_acquire)) {
        /* Let a broken waiter finish so the failure path cannot leak a child. */
        if (release_child(gate[1]) != 0)
            return -1;
        pthread_join(thread, NULL);
        fprintf(stderr, "directed wait did not react to a thread signal\n");
        return -1;
    }
    if (pthread_join(thread, NULL) != 0)
        return fail("pthread_join directed waiter");
    if (ctx.result != -1 || ctx.error != EINTR || sigusr1_count < 1) {
        fprintf(stderr,
            "directed wait was not interrupted: result=%d errno=%d count=%d\n",
            (int)ctx.result, ctx.error, (int)sigusr1_count);
        return -1;
    }

    if (release_child(gate[1]) != 0)
        return -1;
    int status = 0;
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) ||
        WEXITSTATUS(status) != 30) {
        fprintf(stderr, "directed child exit mismatch: status=%#x\n", status);
        return -1;
    }

    action.sa_handler = SIG_DFL;
    if (sigaction(SIGUSR1, &action, NULL) != 0)
        return fail("restore directed SIGUSR1");
    return 0;
}

struct restart_cancel_ctx {
    pid_t child;
    atomic_int ready;
    atomic_int cleanup_ran;
    pid_t result;
    int error;
};

static void record_restart_cancel(void *opaque)
{
    atomic_store_explicit((atomic_int *)opaque, 1, memory_order_release);
}

static void *restart_cancel_wait_thread(void *opaque)
{
    struct restart_cancel_ctx *ctx = opaque;
    int old_state;
    int status = 0;

    if (pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &old_state) != 0)
        return (void *)(uintptr_t)1;
    if (pthread_cancel(pthread_self()) != 0)
        return (void *)(uintptr_t)2;

    atomic_store_explicit(&ctx->ready, 1, memory_order_release);
    pthread_cleanup_push(record_restart_cancel, &ctx->cleanup_ran);
    errno = 0;
    ctx->result = waitpid(ctx->child, &status, 0);
    ctx->error = errno;
    pthread_cleanup_pop(0);
    return NULL;
}

static int test_sa_restart_checks_pending_cancel_before_retry(void)
{
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = enable_pending_cancel;
    action.sa_flags = SA_RESTART;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR2, &action, NULL) != 0)
        return fail("restart-cancel sigaction");
    cancel_enable_error = 0;

    int gate[2];
    if (pipe(gate) != 0)
        return fail("restart-cancel pipe");
    pid_t pid = fork();
    if (pid < 0)
        return fail("restart-cancel fork");
    if (pid == 0) {
        close(gate[1]);
        char byte;
        if (read(gate[0], &byte, 1) != 1)
            _exit(121);
        close(gate[0]);
        _exit(31);
    }
    close(gate[0]);

    struct restart_cancel_ctx ctx = {
        .child = pid,
        .ready = ATOMIC_VAR_INIT(0),
        .cleanup_ran = ATOMIC_VAR_INIT(0),
        .result = 0,
        .error = 0,
    };
    pthread_t thread;
    int create_error = pthread_create(
        &thread,
        NULL,
        restart_cancel_wait_thread,
        &ctx
    );
    if (create_error != 0) {
        errno = create_error;
        return fail("restart-cancel pthread_create");
    }
    while (!atomic_load_explicit(&ctx.ready, memory_order_acquire))
        usleep(1000);
    usleep(20000);

    int kill_error = pthread_kill(thread, SIGUSR2);
    if (kill_error != 0) {
        errno = kill_error;
        return fail("restart-cancel pthread_kill");
    }

    int canceled_before_child_exit = 0;
    for (int i = 0; i < 250; i++) {
        if (atomic_load_explicit(&ctx.cleanup_ran, memory_order_acquire)) {
            canceled_before_child_exit = 1;
            break;
        }
        usleep(1000);
    }

    if (release_child(gate[1]) != 0)
        return -1;
    void *joined = NULL;
    if (pthread_join(thread, &joined) != 0)
        return fail("restart-cancel pthread_join");

    int status = 0;
    if (canceled_before_child_exit) {
        if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) ||
            WEXITSTATUS(status) != 31) {
            fprintf(stderr, "restart-cancel child status mismatch: %#x\n", status);
            return -1;
        }
    }

    action.sa_handler = SIG_DFL;
    action.sa_flags = 0;
    if (sigaction(SIGUSR2, &action, NULL) != 0)
        return fail("restore restart-cancel SIGUSR2");

    if (!canceled_before_child_exit || joined != PTHREAD_CANCELED ||
        cancel_enable_error != 0) {
        fprintf(stderr,
            "SA_RESTART swallowed cancellation: early=%d joined=%p "
            "handler_error=%d wait_result=%d wait_errno=%d\n",
            canceled_before_child_exit, joined, (int)cancel_enable_error,
            (int)ctx.result, ctx.error);
        return -1;
    }
    return 0;
}

static int test_siginfo_layout(void)
{
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_sigaction = capture_siginfo;
    action.sa_flags = SA_SIGINFO;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR2, &action, NULL) != 0)
        return fail("siginfo sigaction");
    siginfo_signo = 0;
    siginfo_pid = 0;
    siginfo_uid = -1;

    if (raise(SIGUSR2) != 0)
        return fail("siginfo raise");
    if (siginfo_signo != SIGUSR2 || siginfo_pid != getpid() ||
        siginfo_uid != (sig_atomic_t)getuid()) {
        fprintf(stderr,
            "siginfo layout mismatch: signo=%d pid=%d uid=%d expected pid=%d uid=%u\n",
            (int)siginfo_signo, (int)siginfo_pid, (int)siginfo_uid,
            (int)getpid(), (unsigned)getuid());
        return -1;
    }

    action.sa_handler = SIG_DFL;
    action.sa_flags = 0;
    if (sigaction(SIGUSR2, &action, NULL) != 0)
        return fail("restore siginfo SIGUSR2");
    return 0;
}

static int test_caught_sigcont_precedes_stop_boundary_return(void)
{
    pid_t pid = fork();
    if (pid < 0)
        return fail("SIGCONT ordering fork");
    if (pid == 0) {
        struct sigaction action;
        memset(&action, 0, sizeof(action));
        action.sa_handler = count_sigcont;
        sigemptyset(&action.sa_mask);
        if (sigaction(SIGCONT, &action, NULL) != 0)
            _exit(121);
        sigcont_count = 0;
        if (raise(SIGSTOP) != 0)
            _exit(122);
        _exit(sigcont_count == 1 ? 0 : 123);
    }

    int status = 0;
    if (waitpid(pid, &status, WUNTRACED) != pid || !WIFSTOPPED(status)) {
        fprintf(stderr, "SIGCONT ordering child did not stop: status=%#x\n", status);
        return -1;
    }
    if (kill(pid, SIGCONT) != 0)
        return fail("SIGCONT ordering continue");
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) ||
        WEXITSTATUS(status) != 0) {
        fprintf(stderr,
            "caught SIGCONT did not run before resume boundary: status=%#x\n",
            status);
        return -1;
    }
    return 0;
}

#if __SIZEOF_POINTER__ == 8
struct memory64_k_sigaction {
    uint64_t handler;
    uint64_t flags;
    uint64_t mask;
    uint64_t unused;
};

static int memory64_action_is_configured(void)
{
    struct sigaction current;
    memset(&current, 0, sizeof(current));
    if (sigaction(SIGUSR2, NULL, &current) != 0)
        return fail("memory64 query sigaction");
    if (current.sa_sigaction != capture_siginfo ||
        (current.sa_flags & (SA_SIGINFO | SA_RESTART)) !=
            (SA_SIGINFO | SA_RESTART) ||
        sigismember(&current.sa_mask, SIGUSR1) != 1) {
        fprintf(stderr,
            "memory64 sigaction round-trip mismatch: handler=%p flags=%#x "
            "mask=%d\n",
            (void *)current.sa_sigaction, current.sa_flags,
            sigismember(&current.sa_mask, SIGUSR1));
        return -1;
    }
    return 0;
}

static int test_memory64_sigaction_wire(void)
{
    struct sigaction original;
    struct sigaction configured;
    struct sigaction previous;
    memset(&original, 0, sizeof(original));
    memset(&configured, 0, sizeof(configured));
    memset(&previous, 0, sizeof(previous));
    if (sigaction(SIGUSR2, NULL, &original) != 0)
        return fail("memory64 save sigaction");

    configured.sa_sigaction = capture_siginfo;
    configured.sa_flags = SA_SIGINFO | SA_RESTART;
    sigemptyset(&configured.sa_mask);
    sigaddset(&configured.sa_mask, SIGUSR1);
    if (sigaction(SIGUSR2, &configured, &previous) != 0)
        return fail("memory64 set sigaction");
    if (previous.sa_handler != original.sa_handler ||
        previous.sa_flags != original.sa_flags ||
        memcmp(&previous.sa_mask, &original.sa_mask,
            sizeof(previous.sa_mask)) != 0) {
        fprintf(stderr, "memory64 old sigaction did not round-trip\n");
        return -1;
    }
    if (memory64_action_is_configured() != 0)
        return -1;

    errno = 0;
    if (syscall(SYS_rt_sigaction, SIGUSR2, (void *)(uintptr_t)-1,
            NULL, 8) != -1 || errno != EFAULT ||
        memory64_action_is_configured() != 0) {
        fprintf(stderr, "memory64 invalid sigaction input mismatch: errno=%d\n",
            errno);
        return -1;
    }
    errno = 0;
    if (syscall(SYS_rt_sigaction, SIGUSR2, NULL,
            (void *)(uintptr_t)-1, 8) != -1 || errno != EFAULT ||
        memory64_action_is_configured() != 0) {
        fprintf(stderr, "memory64 invalid sigaction output mismatch: errno=%d\n",
            errno);
        return -1;
    }

    uintptr_t old_pages = (uintptr_t)__builtin_wasm_memory_grow(0, 1);
    if (old_pages == (uintptr_t)-1) {
        fprintf(stderr, "memory64 could not grow memory for range test\n");
        return -1;
    }
    unsigned char *tail =
        (unsigned char *)((old_pages + 1) * 65536u - 23u);
    memset(tail, 0xa5, 23);
    errno = 0;
    if (syscall(SYS_rt_sigaction, SIGUSR2, tail, NULL, 8) != -1 ||
        errno != EFAULT || memory64_action_is_configured() != 0) {
        fprintf(stderr, "memory64 short sigaction input mismatch: errno=%d\n",
            errno);
        return -1;
    }
    errno = 0;
    if (syscall(SYS_rt_sigaction, SIGUSR2, NULL, tail, 8) != -1 ||
        errno != EFAULT || memory64_action_is_configured() != 0) {
        fprintf(stderr, "memory64 short sigaction output mismatch: errno=%d\n",
            errno);
        return -1;
    }
    for (size_t i = 0; i < 23; i++) {
        if (tail[i] != 0xa5) {
            fprintf(stderr, "memory64 invalid sigaction output mutated byte %zu\n",
                i);
            return -1;
        }
    }

    struct memory64_k_sigaction raw;
    struct memory64_k_sigaction unchanged;
    memset(&raw, 0, sizeof(raw));
    memset(&unchanged, 0xa5, sizeof(unchanged));
    raw.handler = UINT64_C(1) << 32;
    errno = 0;
    if (syscall(SYS_rt_sigaction, SIGUSR2, &raw, &unchanged, 8) != -1 ||
        errno != EINVAL || memory64_action_is_configured() != 0) {
        fprintf(stderr, "memory64 wide sigaction handler mismatch: errno=%d\n",
            errno);
        return -1;
    }
    for (size_t i = 0; i < sizeof(unchanged); i++) {
        if (((unsigned char *)&unchanged)[i] != 0xa5) {
            fprintf(stderr, "memory64 rejected sigaction mutated old action\n");
            return -1;
        }
    }

    raw.handler = (uint64_t)(uintptr_t)capture_siginfo;
    raw.flags = UINT64_C(1) << 32;
    errno = 0;
    if (syscall(SYS_rt_sigaction, SIGUSR2, &raw, NULL, 8) != -1 ||
        errno != EINVAL || memory64_action_is_configured() != 0) {
        fprintf(stderr, "memory64 wide sigaction flags mismatch: errno=%d\n",
            errno);
        return -1;
    }

    if (sigaction(SIGUSR2, &original, NULL) != 0)
        return fail("memory64 restore sigaction");
    return 0;
}

/*
 * Fork rewind instrumentation is currently a wasm32 artifact contract.  The
 * memory64 variant still needs to exercise its distinct siginfo_t and public
 * struct rusage layouts, so create a same-architecture child through Kandelo's
 * non-forking posix_spawn path.  The fixture re-enters itself in child mode,
 * stops, then waits on an inherited pipe after SIGCONT so the parent cannot
 * lose the continued event to a fast exit before inspecting it.
 */
#define MEMORY64_WAIT_CHILD_PATH "/wait-lifecycle-test-wasm64"
#define MEMORY64_WAIT_CHILD_MODE "--memory64-wait-child"

static int parse_memory64_child_fd(const char *text, int *fd_out)
{
    char trailing;
    int fd;
    if (sscanf(text, "%d%c", &fd, &trailing) != 1 || fd < 0) {
        fprintf(stderr, "memory64 child received invalid fd: %s\n", text);
        return -1;
    }
    *fd_out = fd;
    return 0;
}

static int run_memory64_wait_child(int argc, char **argv)
{
    int read_fd;
    int write_fd;
    if (argc != 4 || parse_memory64_child_fd(argv[2], &read_fd) != 0 ||
        parse_memory64_child_fd(argv[3], &write_fd) != 0)
        return 118;
    if (close(write_fd) != 0) {
        fail("memory64 child close write gate");
        return 119;
    }
    if (raise(SIGSTOP) != 0) {
        fail("memory64 child SIGSTOP");
        return 120;
    }
    char byte = 0;
    if (read(read_fd, &byte, 1) != 1) {
        fail("memory64 child read gate");
        return 121;
    }
    if (close(read_fd) != 0) {
        fail("memory64 child close read gate");
        return 122;
    }
    return 7;
}

static int test_memory64_wait_layouts(void)
{
    int gate[2];
    if (pipe(gate) != 0)
        return fail("memory64 gate pipe");

    char read_fd[16];
    char write_fd[16];
    int read_len = snprintf(read_fd, sizeof(read_fd), "%d", gate[0]);
    int write_len = snprintf(write_fd, sizeof(write_fd), "%d", gate[1]);
    if (read_len < 0 || (size_t)read_len >= sizeof(read_fd) ||
        write_len < 0 || (size_t)write_len >= sizeof(write_fd)) {
        fprintf(stderr, "memory64 child fd argument was truncated\n");
        close(gate[0]);
        close(gate[1]);
        return -1;
    }

    char *argv[] = { MEMORY64_WAIT_CHILD_PATH, MEMORY64_WAIT_CHILD_MODE,
        read_fd, write_fd, NULL };
    pid_t pid = -1;
    int spawn_error = posix_spawn(&pid, argv[0], NULL, NULL, argv, environ);
    if (spawn_error != 0) {
        errno = spawn_error;
        close(gate[0]);
        close(gate[1]);
        return fail("memory64 posix_spawn");
    }
    close(gate[0]);

    siginfo_t info;
    memset(&info, 0x5a, sizeof(info));
    if (waitid(P_PID, (id_t)pid, &info, WSTOPPED | WNOWAIT) != 0 ||
        info.si_signo != SIGCHLD || info.si_pid != pid ||
        info.si_uid != getuid() || info.si_code != CLD_STOPPED ||
        info.si_status != SIGSTOP) {
        fprintf(stderr,
            "memory64 waitid stop mismatch: signo=%d pid=%d uid=%u "
            "code=%d status=%d\n",
            info.si_signo, (int)info.si_pid, (unsigned)info.si_uid,
            info.si_code, info.si_status);
        close(gate[1]);
        return -1;
    }

    memset(&info, 0x5a, sizeof(info));
    if (waitid(P_PID, (id_t)pid, &info, WSTOPPED) != 0 ||
        info.si_code != CLD_STOPPED || info.si_status != SIGSTOP) {
        fprintf(stderr, "memory64 consuming waitid stop mismatch\n");
        close(gate[1]);
        return -1;
    }

    if (kill(pid, SIGCONT) != 0) {
        close(gate[1]);
        return fail("memory64 SIGCONT");
    }
    memset(&info, 0x5a, sizeof(info));
    if (waitid(P_PID, (id_t)pid, &info, WCONTINUED) != 0 ||
        info.si_signo != SIGCHLD || info.si_pid != pid ||
        info.si_code != CLD_CONTINUED || info.si_status != SIGCONT) {
        fprintf(stderr,
            "memory64 waitid continue mismatch: signo=%d pid=%d "
            "code=%d status=%d\n",
            info.si_signo, (int)info.si_pid, info.si_code, info.si_status);
        close(gate[1]);
        return -1;
    }

    if (write(gate[1], "x", 1) != 1) {
        close(gate[1]);
        return fail("memory64 release child");
    }
    if (close(gate[1]) != 0)
        return fail("memory64 close child gate");

    int status = 0;
    struct rusage usage;
    memset(&usage, 0xa5, sizeof(usage));
    pid_t got = wait4(pid, &status, 0, &usage);
    if (got != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 7 ||
        expect_zero_rusage(&usage) != 0) {
        fprintf(stderr, "memory64 wait4 exit mismatch: got=%d status=%#x\n",
            (int)got, status);
        return -1;
    }

    if (test_getrusage_pointer_validation() != 0 ||
        test_memory64_sigaction_wire() != 0)
        return -1;
    return test_siginfo_layout();
}
#endif

int main(int argc, char **argv)
{
#if __SIZEOF_POINTER__ == 8
    if (argc > 1 && strcmp(argv[1], MEMORY64_WAIT_CHILD_MODE) == 0)
        return run_memory64_wait_child(argc, argv);
#endif
    if (test_cancel_preserves_completed_syscall() != 0)
        return 12;
#if __SIZEOF_POINTER__ == 8
    if (test_memory64_wait_layouts() != 0)
        return 1;
    puts("WAIT_LIFECYCLE_PASS");
    return 0;
#else
    (void)argc;
    (void)argv;
    if (test_wait4_lifecycle() != 0)
        return 1;
    if (test_waitid_lifecycle() != 0)
        return 2;
    if (test_sa_nocldstop() != 0)
        return 3;
    if (test_sigkill_stopped_child() != 0)
        return 4;
    if (test_getrusage_pointer_validation() != 0)
        return 5;
    if (test_nonmatching_sigchld_interrupts_wait() != 0)
        return 6;
    if (test_wait_signal_restart() != 0)
        return 7;
    if (test_pthread_kill_interrupts_exact_waiter() != 0)
        return 8;
    if (test_sa_restart_checks_pending_cancel_before_retry() != 0)
        return 9;
    if (test_siginfo_layout() != 0)
        return 10;
    if (test_caught_sigcont_precedes_stop_boundary_return() != 0)
        return 11;
    puts("WAIT_LIFECYCLE_PASS");
    return 0;
#endif
}
