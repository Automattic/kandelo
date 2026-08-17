#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <setjmp.h>
#include <linux/fb.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/syscall.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum wait_api {
    WAIT_API_PPOLL,
    WAIT_API_PSELECT,
};

enum signal_arrival {
    SIGNAL_PENDING_BEFORE_ENTRY,
    SIGNAL_ARRIVING_WHILE_BLOCKED,
};

static volatile sig_atomic_t handler_count;
static volatile sig_atomic_t handler_failed;
static volatile sig_atomic_t handler_saw_alarm;
static volatile sig_atomic_t handler_saw_sa_mask;
static volatile sig_atomic_t handler_saw_original;
static volatile sig_atomic_t handler_saw_temporary;
static volatile sig_atomic_t handler_mask_exact;
static volatile sig_atomic_t readiness_write_fd = -1;
static volatile sig_atomic_t readiness_read_fd = -1;
static volatile sig_atomic_t restart_window_enabled;
static volatile sig_atomic_t restart_signal_count;
static volatile sig_atomic_t restart_signal_failed;
static volatile sig_atomic_t restart_signal_saw_original;
static volatile sig_atomic_t restart_signal_mask_exact;
static volatile sig_atomic_t restart_signal_consumed_readiness;
static volatile sig_atomic_t deadline_window_enabled;
static volatile sig_atomic_t cancel_window_enabled;
static volatile sig_atomic_t nested_wait_kind;
static volatile sig_atomic_t nested_wait_result;
static volatile sig_atomic_t nested_wait_errno;
static volatile sig_atomic_t nested_wait_failed;
static volatile sig_atomic_t nested_observed_hup;
static volatile sig_atomic_t nested_observed_alrm;
static volatile sig_atomic_t nested_observed_usr1;
static volatile sig_atomic_t nested_observed_usr2;
static volatile sig_atomic_t nested_observed_term;
static volatile sig_atomic_t nested_wakeup_count;
static volatile sig_atomic_t collision_inner_result;
static volatile sig_atomic_t collision_inner_ready;
static volatile sig_atomic_t collision_handler_mask_exact;

static _Atomic uint32_t host_gate;
static _Atomic uint32_t restart_gate;
static _Atomic uint32_t deadline_gate;
static _Atomic uint32_t nested_wake_gate;
static sigset_t expected_handler_mask;
static sigset_t expected_restart_signal_mask;
static sigset_t nested_replacement_mask;
static sigset_t nested_expected_handler_mask;
static const char blocked_marker[] = "TASK16_BLOCK\n";
static char restart_marker[80];
static size_t restart_marker_len;
static char deadline_marker[80];
static size_t deadline_marker_len;
static int browser_framebuffer_fd = -1;
static void *browser_framebuffer_mapping = MAP_FAILED;
static int nested_ready_fd = -1;
static pthread_t nested_target_thread;
static pthread_t nonlocal_helper_thread;
static int nested_wakeup_signal;
static int nested_wakeup_delay_ms;
static struct pollfd *collision_pollfd;
static const struct timespec *collision_timeout;
static const sigset_t *collision_replacement;
static int collision_read_fd = -1;
static int collision_write_fd = -1;
static sigjmp_buf nonlocal_landing;
static jmp_buf generic_landing;
static sigjmp_buf no_mask_landing;
static sigset_t generic_landing_mask;
static sigset_t no_mask_landing_mask;
static volatile sig_atomic_t generic_jump_failed;
static volatile sig_atomic_t generic_jump_handler_depth;
static volatile sig_atomic_t no_mask_jump_failed;
static volatile sig_atomic_t no_mask_jump_handler_depth;

extern unsigned long __wasm_posix_caught_handler_depth(void);

enum nested_wait {
    NESTED_WAIT_NONE,
    NESTED_WAIT_PPOLL,
    NESTED_WAIT_PSELECT,
    NESTED_WAIT_SIGSUSPEND,
    NESTED_WAIT_PAUSE,
};

static int bind_browser_gate_memory(void)
{
    struct fb_fix_screeninfo fixed;

    browser_framebuffer_fd = open("/dev/fb0", O_RDWR);
    if (browser_framebuffer_fd < 0 ||
        ioctl(browser_framebuffer_fd, FBIOGET_FSCREENINFO, &fixed) != 0)
        return -1;
    browser_framebuffer_mapping = mmap(
        NULL,
        fixed.smem_len,
        PROT_READ | PROT_WRITE,
        MAP_SHARED,
        browser_framebuffer_fd,
        0
    );
    return browser_framebuffer_mapping == MAP_FAILED ? -1 : 0;
}

static const char *api_name(enum wait_api api)
{
    return api == WAIT_API_PPOLL ? "ppoll" : "pselect";
}

static const char *arrival_name(enum signal_arrival arrival)
{
    return arrival == SIGNAL_PENDING_BEFORE_ENTRY
        ? "pending-before-entry"
        : "arriving-while-blocked";
}

static long elapsed_ms(struct timespec start, struct timespec end)
{
    return (end.tv_sec - start.tv_sec) * 1000L
        + (end.tv_nsec - start.tv_nsec) / 1000000L;
}

static int signal_masks_equal(const sigset_t *left, const sigset_t *right)
{
    for (int signum = 1; signum < NSIG; signum++) {
        int left_member = sigismember(left, signum);
        int right_member = sigismember(right, signum);

        if (left_member < 0 || right_member < 0 ||
            left_member != right_member)
            return 0;
    }
    return 1;
}

static void on_nested_wakeup(int signum)
{
    if (signum != nested_wakeup_signal)
        nested_wait_failed = 1;
    nested_wakeup_count++;
}

static void *send_nested_wakeup(void *unused)
{
    struct timespec delay;

    (void)unused;
    while (atomic_load_explicit(&nested_wake_gate, memory_order_acquire) == 0)
        sched_yield();
    if (nested_wakeup_delay_ms > 0) {
        delay.tv_sec = nested_wakeup_delay_ms / 1000;
        delay.tv_nsec = (nested_wakeup_delay_ms % 1000) * 1000000L;
        nanosleep(&delay, NULL);
    }
    if (pthread_kill(nested_target_thread, nested_wakeup_signal) != 0)
        nested_wait_failed = 1;
    return NULL;
}

static void on_nested_outer(int signum)
{
    const struct timespec no_wait = { 0, 0 };
    sigset_t observed;
    int result = -2;
    int result_errno = 0;

    if (signum != SIGALRM ||
        sigprocmask(SIG_SETMASK, NULL, &observed) != 0 ||
        !signal_masks_equal(&observed, &nested_expected_handler_mask)) {
        nested_wait_failed = 1;
        return;
    }

    errno = 0;
    switch (nested_wait_kind) {
    case NESTED_WAIT_PPOLL: {
        struct pollfd pfd = {
            .fd = nested_ready_fd,
            .events = POLLIN,
            .revents = 0,
        };
        result = ppoll(&pfd, 1, &no_wait, &nested_replacement_mask);
        if (result != 1 || (pfd.revents & POLLIN) == 0)
            nested_wait_failed = 1;
        break;
    }
    case NESTED_WAIT_PSELECT: {
        fd_set readfds;

        FD_ZERO(&readfds);
        FD_SET(nested_ready_fd, &readfds);
        result = pselect(
            nested_ready_fd + 1,
            &readfds,
            NULL,
            NULL,
            &no_wait,
            &nested_replacement_mask
        );
        if (result != 1 || !FD_ISSET(nested_ready_fd, &readfds))
            nested_wait_failed = 1;
        break;
    }
    case NESTED_WAIT_SIGSUSPEND:
        atomic_store_explicit(&nested_wake_gate, 1, memory_order_release);
        result = sigsuspend(&nested_replacement_mask);
        result_errno = errno;
        if (result != -1 || result_errno != EINTR)
            nested_wait_failed = 1;
        break;
    case NESTED_WAIT_PAUSE:
        atomic_store_explicit(&nested_wake_gate, 1, memory_order_release);
        result = pause();
        result_errno = errno;
        if (result != -1 || result_errno != EINTR)
            nested_wait_failed = 1;
        break;
    default:
        nested_wait_failed = 1;
        return;
    }
    nested_wait_result = result;
    nested_wait_errno = result_errno;
    if (sigprocmask(SIG_SETMASK, NULL, &observed) != 0) {
        nested_wait_failed = 1;
    } else {
        nested_observed_hup = sigismember(&observed, SIGHUP);
        nested_observed_alrm = sigismember(&observed, SIGALRM);
        nested_observed_usr1 = sigismember(&observed, SIGUSR1);
        nested_observed_usr2 = sigismember(&observed, SIGUSR2);
        nested_observed_term = sigismember(&observed, SIGTERM);
        if (!signal_masks_equal(&observed, &nested_expected_handler_mask))
            nested_wait_failed = 1;
    }
}

static void on_collision_alarm(int signum)
{
    sigset_t observed;
    char byte;

    if (signum != SIGALRM || collision_write_fd < 0 ||
        write(collision_write_fd, "c", 1) != 1) {
        nested_wait_failed = 1;
        return;
    }
    /* A handler may explicitly restore the replacement mask before entering
     * a genuinely nested wait.  Retry ownership must not be inferred from
     * mask values alone: this inner ppoll still needs its own LIFO frame. */
    if (sigprocmask(SIG_SETMASK, collision_replacement, NULL) != 0) {
        nested_wait_failed = 1;
        return;
    }
    collision_pollfd->revents = 0;
    collision_inner_result = ppoll(
        collision_pollfd,
        1,
        collision_timeout,
        collision_replacement
    );
    collision_inner_ready = collision_inner_result == 1 &&
        (collision_pollfd->revents & POLLIN) != 0;
    if (!collision_inner_ready || read(collision_read_fd, &byte, 1) != 1)
        nested_wait_failed = 1;
    if (sigprocmask(SIG_SETMASK, NULL, &observed) != 0)
        nested_wait_failed = 1;
    else
        collision_handler_mask_exact = signal_masks_equal(
            &observed,
            collision_replacement
        );
    if (deadline_marker_len == 0 ||
        write(STDOUT_FILENO, deadline_marker, deadline_marker_len) !=
            (ssize_t)deadline_marker_len) {
        nested_wait_failed = 1;
        return;
    }
    while (atomic_load_explicit(&deadline_gate, memory_order_acquire) == 0) {
        /* Hold the outer catcher past its original absolute deadline. */
    }
}

static void on_nonlocal_jump(int signum)
{
    if (signum != SIGUSR1)
        nested_wait_failed = 1;
    siglongjmp(nonlocal_landing, 1);
}

static void on_nonlocal_outer(int signum)
{
    sigset_t inner_mask;

    if (signum != SIGALRM) {
        nested_wait_failed = 1;
        return;
    }
    sigemptyset(&inner_mask);
    sigaddset(&inner_mask, SIGTERM);
    atomic_store_explicit(&nested_wake_gate, 1, memory_order_release);
    (void)sigsuspend(&inner_mask);
    nested_wait_failed = 1;
}

static void on_generic_longjmp(int signum)
{
    generic_jump_handler_depth =
        (sig_atomic_t)__wasm_posix_caught_handler_depth();
    if (signum != SIGALRM ||
        sigprocmask(SIG_SETMASK, &generic_landing_mask, NULL) != 0)
        generic_jump_failed = 1;
    longjmp(generic_landing, 7);
}

static void on_no_mask_siglongjmp(int signum)
{
    no_mask_jump_handler_depth =
        (sig_atomic_t)__wasm_posix_caught_handler_depth();
    if (signum != SIGUSR1 ||
        sigprocmask(SIG_SETMASK, &no_mask_landing_mask, NULL) != 0)
        no_mask_jump_failed = 1;
    siglongjmp(no_mask_landing, 9);
}

/*
 * The actual signal catcher, rather than a host test double, observes its
 * installed mask.  SIGUSR2 is the caller's original mask, SIGTERM is the
 * replacement ppoll/pselect mask, SIGUSR1 is sa_mask, and SIGALRM is the
 * delivered signal.  They are deliberately disjoint sentinels.
 */
static void on_alarm(int signum)
{
    sigset_t observed;
    char byte = 'r';

    if (signum != SIGALRM ||
        sigprocmask(SIG_SETMASK, NULL, &observed) != 0 ||
        (!deadline_window_enabled &&
         (readiness_write_fd < 0 ||
          write((int)readiness_write_fd, &byte, 1) != 1))) {
        handler_failed = 1;
        return;
    }

    handler_count++;
    handler_saw_alarm = sigismember(&observed, SIGALRM) == 1;
    handler_saw_sa_mask = sigismember(&observed, SIGUSR1) == 1;
    handler_saw_original = sigismember(&observed, SIGUSR2) == 1;
    handler_saw_temporary = sigismember(&observed, SIGTERM) == 1;
    handler_mask_exact = signal_masks_equal(&observed, &expected_handler_mask);

    if (deadline_window_enabled) {
        if (deadline_marker_len == 0 ||
            write(STDOUT_FILENO, deadline_marker, deadline_marker_len) !=
                (ssize_t)deadline_marker_len) {
            handler_failed = 1;
            return;
        }
        while (atomic_load_explicit(&deadline_gate, memory_order_acquire) == 0) {
            /* The host holds this handler beyond the original ppoll deadline. */
        }
    } else if (restart_window_enabled) {
        if (restart_marker_len == 0 ||
            write(STDOUT_FILENO, restart_marker, restart_marker_len) !=
                (ssize_t)restart_marker_len) {
            handler_failed = 1;
            return;
        }
        while (atomic_load_explicit(&restart_gate, memory_order_acquire) == 0) {
            /* The host queues SIGTERM before releasing this handler. */
        }
        if (sigprocmask(SIG_SETMASK, NULL, &observed) != 0 ||
            sigismember(&observed, SIGTERM) != 1) {
            handler_failed = 1;
        }
    }
    if (cancel_window_enabled && pthread_cancel(pthread_self()) != 0)
        handler_failed = 1;
}

static void on_restart_signal(int signum)
{
    sigset_t observed;
    char byte;

    if (signum != SIGTERM ||
        sigprocmask(SIG_SETMASK, NULL, &observed) != 0 ||
        readiness_read_fd < 0) {
        restart_signal_failed = 1;
        return;
    }

    restart_signal_count++;
    restart_signal_saw_original = sigismember(&observed, SIGUSR2) == 1;
    restart_signal_mask_exact = signal_masks_equal(
        &observed,
        &expected_restart_signal_mask
    );
    restart_signal_consumed_readiness =
        read((int)readiness_read_fd, &byte, 1) == 1;
}

/*
 * The Node host test injects SIGALRM after it observes pending_marker.  This
 * deliberate non-syscall delay leaves the signal pending before the next
 * ppoll/pselect entry, without using raise() from the guest as a stand-in for
 * the host-to-kernel signal path.
 */
static int wait_for_host_injection(void)
{
    char marker[64];
    int marker_len;

    atomic_store_explicit(&host_gate, 0, memory_order_relaxed);
    marker_len = snprintf(
        marker,
        sizeof(marker),
        "TASK16_GATE=%lu\n",
        (unsigned long)(uintptr_t)&host_gate
    );
    if (marker_len <= 0 || marker_len >= (int)sizeof(marker) ||
        write(STDOUT_FILENO, marker, (size_t)marker_len) != marker_len) {
        return -1;
    }
    while (atomic_load_explicit(&host_gate, memory_order_acquire) == 0) {
        /* The host releases this gate after signalProcess() queued SIGALRM. */
    }
    return 0;
}

/* The host schedules SIGALRM after this marker, while this call is parked. */
static int mark_wait_about_to_block(void)
{
    return write(STDOUT_FILENO, blocked_marker, sizeof(blocked_marker) - 1)
        == (ssize_t)(sizeof(blocked_marker) - 1) ? 0 : -1;
}

static int call_wait(
    enum wait_api api,
    int read_fd,
    const struct timespec *timeout,
    const sigset_t *replacement_mask,
    int *ready
)
{
    if (api == WAIT_API_PPOLL) {
        struct pollfd pollfd = {
            .fd = read_fd,
            .events = POLLIN,
            .revents = 0,
        };
        int result = ppoll(&pollfd, 1, timeout, replacement_mask);

        *ready = result == 1 && (pollfd.revents & POLLIN) != 0;
        return result;
    }
    {
        fd_set readfds;
        int result;

        FD_ZERO(&readfds);
        FD_SET(read_fd, &readfds);
        result = pselect(
            read_fd + 1,
            &readfds,
            NULL,
            NULL,
            timeout,
            replacement_mask
        );
        *ready = result == 1 && FD_ISSET(read_fd, &readfds);
        return result;
    }
}

static int check_restored_mask(const sigset_t *original)
{
    sigset_t observed;

    if (sigprocmask(SIG_SETMASK, NULL, &observed) != 0)
        return -1;
    return signal_masks_equal(&observed, original) ? 0 : -1;
}

static int check_readiness_after_interrupt(enum wait_api api, int read_fd)
{
    const struct timespec no_wait = { 0, 0 };
    char byte = 'x';
    int result;

    if (api == WAIT_API_PPOLL) {
        struct pollfd ready = {
            .fd = read_fd,
            .events = POLLIN,
            .revents = 0,
        };
        result = ppoll(&ready, 1, &no_wait, NULL);
        if (result != 1 || (ready.revents & POLLIN) == 0)
            result = -1;
        else
            result = 0;
    } else {
        fd_set readfds;

        FD_ZERO(&readfds);
        FD_SET(read_fd, &readfds);
        result = pselect(read_fd + 1, &readfds, NULL, NULL, &no_wait, NULL);
        if (result != 1 || !FD_ISSET(read_fd, &readfds))
            result = -1;
        else
            result = 0;
    }

    if (result == 0 && read(read_fd, &byte, 1) != 1)
        result = -1;
    return result;
}

static int run_case(
    enum wait_api api,
    enum signal_arrival arrival,
    int use_replacement_mask,
    int restart
)
{
    sigset_t original;
    sigset_t replacement;
    sigset_t action_mask;
    struct sigaction action;
    struct timespec timeout = { .tv_sec = 1, .tv_nsec = 0 };
    struct timespec start;
    struct timespec end;
    const sigset_t *wait_mask = NULL;
    int pipefd[2] = { -1, -1 };
    int result;
    int call_errno;
    int wait_reported_readiness;
    int expect_ppoll_restart = api == WAIT_API_PPOLL && restart;
    long duration;

    sigemptyset(&original);
    sigaddset(&original, SIGUSR2);
    sigemptyset(&replacement);
    sigaddset(&replacement, SIGTERM);
    sigemptyset(&action_mask);
    sigaddset(&action_mask, SIGUSR1);

    memset(&action, 0, sizeof(action));
    action.sa_handler = on_alarm;
    action.sa_mask = action_mask;
    action.sa_flags = restart ? SA_RESTART : 0;
    if (sigaction(SIGALRM, &action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &original, NULL) != 0) {
        perror("task16 setup");
        return -1;
    }

    handler_count = 0;
    handler_failed = 0;
    handler_saw_alarm = 0;
    handler_saw_sa_mask = 0;
    handler_saw_original = 0;
    handler_saw_temporary = 0;
    handler_mask_exact = 0;
    expected_handler_mask = use_replacement_mask ? replacement : original;
    sigaddset(&expected_handler_mask, SIGUSR1);
    sigaddset(&expected_handler_mask, SIGALRM);
    if (use_replacement_mask)
        wait_mask = &replacement;
    if (pipe(pipefd) != 0) {
        perror("task16 readiness pipe");
        return -1;
    }
    readiness_write_fd = pipefd[1];

    if (arrival == SIGNAL_PENDING_BEFORE_ENTRY) {
        if (clock_gettime(CLOCK_MONOTONIC, &start) != 0 ||
            wait_for_host_injection() != 0) {
            perror("task16 pending start/gate");
            return -1;
        }
    } else {
        if (mark_wait_about_to_block() != 0 ||
            clock_gettime(CLOCK_MONOTONIC, &start) != 0) {
            perror("task16 blocked marker/start clock");
            return -1;
        }
    }
    errno = 0;
    result = call_wait(
        api,
        pipefd[0],
        &timeout,
        wait_mask,
        &wait_reported_readiness
    );
    call_errno = errno;
    readiness_write_fd = -1;
    if (clock_gettime(CLOCK_MONOTONIC, &end) != 0) {
        perror("task16 end clock");
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }
    duration = elapsed_ms(start, end);
    /*
     * POSIX Issue 8 makes pselect's SA_RESTART result implementation-defined;
     * Kandelo documents and tests its EINTR choice.  ppoll has no equivalent
     * exception, so its SA_RESTART cases must resume through the real libc
     * channel path and observe the handler-produced pipe readiness.
     */
    /* errno is unspecified after ppoll succeeds following a restart. */
    if ((expect_ppoll_restart && (result != 1 || !wait_reported_readiness)) ||
        (!expect_ppoll_restart && (result != -1 || call_errno != EINTR)) ||
        handler_count != 1 ||
        handler_failed || !handler_saw_alarm || !handler_saw_sa_mask ||
        handler_saw_original != !use_replacement_mask ||
        handler_saw_temporary != use_replacement_mask ||
        !handler_mask_exact ||
        check_restored_mask(&original) != 0 ||
        check_readiness_after_interrupt(api, pipefd[0]) != 0 ||
        (arrival == SIGNAL_ARRIVING_WHILE_BLOCKED && duration < 20) ||
        duration >= 1000) {
        fprintf(
            stderr,
            "%s %s mask=%s restart=%d: result=%d errno=%d count=%d "
            "restart-ppoll=%d handler={failed=%d alarm=%d sa=%d "
            "original=%d temporary=%d exact=%d} "
            "elapsed=%ld\n",
            api_name(api), arrival_name(arrival),
            use_replacement_mask ? "replacement" : "null", restart,
            result, call_errno, (int)handler_count, expect_ppoll_restart,
            (int)handler_failed,
            (int)handler_saw_alarm, (int)handler_saw_sa_mask,
            (int)handler_saw_original, (int)handler_saw_temporary,
            (int)handler_mask_exact, duration
        );
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }

    if (close(pipefd[0]) != 0 || close(pipefd[1]) != 0)
        return -1;
    return 0;
}

/*
 * Hold the first handler after it creates readiness, then have the host queue
 * SIGTERM.  SIGTERM is blocked by ppoll's replacement mask, so it must remain
 * pending through handler return and the SA_RESTART resubmission.  If libc
 * exposes the original mask in that window, SIGTERM drains the readiness byte
 * before ppoll is resubmitted and the restarted wait loses the wakeup.
 */
static int run_ppoll_restart_window_case(void)
{
    sigset_t original;
    sigset_t replacement;
    struct sigaction alarm_action;
    struct sigaction restart_action;
    const struct timespec timeout = { .tv_sec = 0, .tv_nsec = 600000000 };
    struct timespec second_start;
    struct timespec second_end;
    struct pollfd pfd;
    int pipefd[2] = { -1, -1 };
    int ready = 0;
    int result;
    int second_result;
    int marker_len;
    long second_duration;

    sigemptyset(&original);
    sigaddset(&original, SIGUSR2);
    sigemptyset(&replacement);
    sigaddset(&replacement, SIGTERM);

    memset(&alarm_action, 0, sizeof(alarm_action));
    alarm_action.sa_handler = on_alarm;
    sigemptyset(&alarm_action.sa_mask);
    alarm_action.sa_flags = SA_RESTART;
    memset(&restart_action, 0, sizeof(restart_action));
    restart_action.sa_handler = on_restart_signal;
    sigemptyset(&restart_action.sa_mask);
    if (sigaction(SIGALRM, &alarm_action, NULL) != 0 ||
        sigaction(SIGTERM, &restart_action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &original, NULL) != 0 ||
        pipe(pipefd) != 0) {
        perror("task16 restart-window setup");
        return -1;
    }

    atomic_store_explicit(&restart_gate, 0, memory_order_relaxed);
    marker_len = snprintf(
        restart_marker,
        sizeof(restart_marker),
        "TASK16_RESTART_GATE=%lu\n",
        (unsigned long)(uintptr_t)&restart_gate
    );
    if (marker_len <= 0 || marker_len >= (int)sizeof(restart_marker)) {
        fputs("task16 restart-window marker overflow\n", stderr);
        return -1;
    }
    restart_marker_len = (size_t)marker_len;
    handler_count = 0;
    handler_failed = 0;
    restart_signal_count = 0;
    restart_signal_failed = 0;
    restart_signal_saw_original = 0;
    restart_signal_mask_exact = 0;
    restart_signal_consumed_readiness = 0;
    restart_window_enabled = 1;
    readiness_read_fd = pipefd[0];
    readiness_write_fd = pipefd[1];
    expected_handler_mask = replacement;
    sigaddset(&expected_handler_mask, SIGALRM);
    expected_restart_signal_mask = original;
    sigaddset(&expected_restart_signal_mask, SIGTERM);

    if (mark_wait_about_to_block() != 0) {
        perror("task16 restart-window blocked marker");
        return -1;
    }
    errno = 0;
    pfd.fd = pipefd[0];
    pfd.events = POLLIN;
    pfd.revents = 0;
    result = ppoll(&pfd, 1, &timeout, &replacement);
    ready = result == 1 && (pfd.revents & POLLIN) != 0;
    restart_window_enabled = 0;
    readiness_read_fd = -1;
    readiness_write_fd = -1;
    if (result != 1 || !ready || handler_count != 1 || handler_failed ||
        !handler_saw_temporary || !handler_mask_exact ||
        restart_signal_count != 1 || restart_signal_failed ||
        !restart_signal_saw_original || !restart_signal_mask_exact ||
        !restart_signal_consumed_readiness ||
        check_restored_mask(&original) != 0) {
        fprintf(
            stderr,
            "ppoll restart-window: result=%d errno=%d ready=%d "
            "first={count=%d failed=%d temporary=%d exact=%d} "
            "second={count=%d failed=%d original=%d exact=%d consumed=%d}\n",
            result, errno, ready, (int)handler_count, (int)handler_failed,
            (int)handler_saw_temporary, (int)handler_mask_exact,
            (int)restart_signal_count, (int)restart_signal_failed,
            (int)restart_signal_saw_original,
            (int)restart_signal_mask_exact,
            (int)restart_signal_consumed_readiness
        );
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }

    /*
     * Reuse every ppoll argument address after the restarted call completed
     * with immediate readiness. Its carried absolute deadline must have been
     * consumed before that terminal dispatch, so this independent wait gets
     * a fresh interval instead of inheriting the first call's remainder.
     */
    pfd.revents = 0;
    if (clock_gettime(CLOCK_MONOTONIC, &second_start) != 0)
        return -1;
    second_result = ppoll(&pfd, 1, &timeout, &replacement);
    if (clock_gettime(CLOCK_MONOTONIC, &second_end) != 0)
        return -1;
    second_duration = elapsed_ms(second_start, second_end);
    if (second_result != 0 || pfd.revents != 0 ||
        second_duration < 550 || second_duration >= 850 ||
        check_restored_mask(&original) != 0) {
        fprintf(
            stderr,
            "ppoll restart carry: result=%d revents=%d elapsed=%ld\n",
            second_result, pfd.revents, second_duration
        );
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }

    if (close(pipefd[0]) != 0 || close(pipefd[1]) != 0)
        return -1;
    return 0;
}

static int run_ppoll_restart_deadline_case(void)
{
    sigset_t original;
    sigset_t replacement;
    struct sigaction action;
    const struct timespec timeout = { .tv_sec = 0, .tv_nsec = 250000000 };
    struct timespec start;
    struct timespec end;
    int marker_len;
    int result;
    long duration;

    sigemptyset(&original);
    sigaddset(&original, SIGUSR2);
    sigemptyset(&replacement);
    sigaddset(&replacement, SIGTERM);
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_alarm;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESTART;
    if (sigaction(SIGALRM, &action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &original, NULL) != 0)
        return -1;

    atomic_store_explicit(&deadline_gate, 0, memory_order_relaxed);
    marker_len = snprintf(
        deadline_marker,
        sizeof(deadline_marker),
        "TASK16_TIMEOUT_GATE=%lu\n",
        (unsigned long)(uintptr_t)&deadline_gate
    );
    if (marker_len <= 0 || marker_len >= (int)sizeof(deadline_marker))
        return -1;
    deadline_marker_len = (size_t)marker_len;
    handler_count = 0;
    handler_failed = 0;
    handler_mask_exact = 0;
    deadline_window_enabled = 1;
    expected_handler_mask = replacement;
    sigaddset(&expected_handler_mask, SIGALRM);

    if (mark_wait_about_to_block() != 0 ||
        clock_gettime(CLOCK_MONOTONIC, &start) != 0)
        return -1;
    result = ppoll(NULL, 0, &timeout, &replacement);
    deadline_window_enabled = 0;
    if (clock_gettime(CLOCK_MONOTONIC, &end) != 0)
        return -1;
    duration = elapsed_ms(start, end);

    if (result != 0 || handler_count != 1 || handler_failed ||
        !handler_saw_temporary || !handler_mask_exact ||
        check_restored_mask(&original) != 0 ||
        duration < 250 || duration >= 450) {
        fprintf(
            stderr,
            "ppoll restart deadline: result=%d elapsed=%ld "
            "handler={count=%d failed=%d temporary=%d exact=%d}\n",
            result, duration, (int)handler_count, (int)handler_failed,
            (int)handler_saw_temporary, (int)handler_mask_exact
        );
        return -1;
    }
    return 0;
}

static int run_ppoll_masked_cancel_case(void)
{
    sigset_t original;
    sigset_t replacement;
    struct sigaction action;
    const struct timespec timeout = { .tv_sec = 1, .tv_nsec = 0 };
    struct pollfd pfd;
    int pipefd[2] = { -1, -1 };
    int old_cancel_state;
    int result;
    int call_errno;
    char byte;

    sigemptyset(&original);
    sigaddset(&original, SIGUSR2);
    sigemptyset(&replacement);
    sigaddset(&replacement, SIGTERM);
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_alarm;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESTART;
    if (sigaction(SIGALRM, &action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &original, NULL) != 0 ||
        pipe(pipefd) != 0 || pthread_setcancelstate(2, &old_cancel_state) != 0)
        return -1;

    handler_count = 0;
    handler_failed = 0;
    handler_mask_exact = 0;
    cancel_window_enabled = 1;
    readiness_write_fd = pipefd[1];
    expected_handler_mask = replacement;
    sigaddset(&expected_handler_mask, SIGALRM);
    pfd.fd = pipefd[0];
    pfd.events = POLLIN;
    pfd.revents = 0;

    if (mark_wait_about_to_block() != 0)
        return -1;
    errno = 0;
    result = ppoll(&pfd, 1, &timeout, &replacement);
    call_errno = errno;
    cancel_window_enabled = 0;
    readiness_write_fd = -1;

    if (result != -1 || call_errno != ECANCELED ||
        read(pipefd[0], &byte, 1) != 1 || handler_count != 1 ||
        handler_failed || !handler_saw_temporary || !handler_mask_exact ||
        check_restored_mask(&original) != 0) {
        fprintf(
            stderr,
            "ppoll masked cancel: result=%d errno=%d "
            "handler={count=%d failed=%d temporary=%d exact=%d}\n",
            result, call_errno, (int)handler_count, (int)handler_failed,
            (int)handler_saw_temporary, (int)handler_mask_exact
        );
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }

    if (close(pipefd[0]) != 0 || close(pipefd[1]) != 0)
        return -1;
    return 0;
}

static int check_wait4_unknown_option(void)
{
    const int task16_unknown_wait_option = 0x40000000;

    errno = 0;
    if (syscall(
            SYS_wait4,
            -1,
            (int *)NULL,
            task16_unknown_wait_option,
            (struct rusage *)NULL
        ) != -1 || errno != EINVAL) {
        fprintf(stderr, "wait4 unknown option: errno=%d\n", errno);
        return -1;
    }
    return 0;
}

static int run_pause_cleanup_case(void)
{
    sigset_t pause_mask;
    sigset_t next_original;
    sigset_t poll_mask;
    struct pollfd pfd;
    const struct timespec no_wait = { .tv_sec = 0, .tv_nsec = 0 };
    int pipefd[2] = { -1, -1 };
    int pause_result;
    int pause_errno;
    int poll_result;
    char byte;

    sigemptyset(&pause_mask);
    sigaddset(&pause_mask, SIGUSR2);
    sigemptyset(&next_original);
    sigaddset(&next_original, SIGTERM);
    sigemptyset(&poll_mask);
    sigaddset(&poll_mask, SIGUSR1);
    if (sigprocmask(SIG_SETMASK, &pause_mask, NULL) != 0 || pipe(pipefd) != 0)
        return -1;

    handler_count = 0;
    handler_failed = 0;
    readiness_write_fd = pipefd[1];
    expected_handler_mask = pause_mask;
    sigaddset(&expected_handler_mask, SIGALRM);

    if (mark_wait_about_to_block() != 0)
        return -1;
    errno = 0;
    pause_result = pause();
    pause_errno = errno;

    if (sigprocmask(SIG_SETMASK, &next_original, NULL) != 0)
        return -1;
    pfd.fd = pipefd[0];
    pfd.events = POLLIN;
    pfd.revents = 0;
    poll_result = ppoll(&pfd, 1, &no_wait, &poll_mask);
    readiness_write_fd = -1;

    if (pause_result != -1 || pause_errno != EINTR || poll_result != 1 ||
        (pfd.revents & POLLIN) == 0 || read(pipefd[0], &byte, 1) != 1 ||
        handler_count != 1 || handler_failed || !handler_mask_exact ||
        check_restored_mask(&next_original) != 0) {
        fprintf(
            stderr,
            "pause cleanup: pause={result=%d errno=%d} poll=%d revents=%d "
            "handler={count=%d failed=%d exact=%d}\n",
            pause_result, pause_errno, poll_result, pfd.revents,
            (int)handler_count, (int)handler_failed, (int)handler_mask_exact
        );
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }

    if (close(pipefd[0]) != 0 || close(pipefd[1]) != 0)
        return -1;
    return 0;
}

static int run_sigsuspend_cleanup_case(void)
{
    sigset_t original;
    sigset_t replacement;
    int pipefd[2] = { -1, -1 };
    int result;
    int call_errno;
    char byte;

    sigemptyset(&original);
    sigaddset(&original, SIGUSR2);
    sigaddset(&original, SIGALRM);
    sigemptyset(&replacement);
    sigaddset(&replacement, SIGTERM);
    if (sigprocmask(SIG_SETMASK, &original, NULL) != 0 || pipe(pipefd) != 0)
        return -1;

    handler_count = 0;
    handler_failed = 0;
    readiness_write_fd = pipefd[1];
    expected_handler_mask = replacement;
    sigaddset(&expected_handler_mask, SIGALRM);
    /* Target the task that owns this wait. A process-directed raise from the
     * pthread subcase may legally route to the main thread instead. */
    if (pthread_kill(pthread_self(), SIGALRM) != 0)
        return -1;

    errno = 0;
    result = sigsuspend(&replacement);
    call_errno = errno;
    readiness_write_fd = -1;

    if (result != -1 || call_errno != EINTR ||
        read(pipefd[0], &byte, 1) != 1 || handler_count != 1 ||
        handler_failed || !handler_saw_temporary || !handler_mask_exact ||
        check_restored_mask(&original) != 0) {
        fprintf(
            stderr,
            "sigsuspend cleanup: result=%d errno=%d "
            "handler={count=%d failed=%d temporary=%d exact=%d}\n",
            result, call_errno, (int)handler_count, (int)handler_failed,
            (int)handler_saw_temporary, (int)handler_mask_exact
        );
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }

    if (close(pipefd[0]) != 0 || close(pipefd[1]) != 0)
        return -1;
    return 0;
}

static int run_nested_wait_case(enum nested_wait kind)
{
    sigset_t original;
    sigset_t outer_replacement;
    struct sigaction outer_action;
    struct sigaction wake_action;
    const struct timespec no_wait = { 0, 0 };
    pthread_t helper;
    int helper_started = 0;
    int pipefd[2] = { -1, -1 };
    int outer_result;
    char byte = 'n';

    sigemptyset(&original);
    sigaddset(&original, SIGALRM);
    sigaddset(&original, SIGUSR2);
    sigemptyset(&outer_replacement);
    sigaddset(&outer_replacement, SIGTERM);
    sigemptyset(&nested_replacement_mask);
    sigaddset(&nested_replacement_mask, SIGHUP);

    memset(&outer_action, 0, sizeof(outer_action));
    outer_action.sa_handler = on_nested_outer;
    sigemptyset(&outer_action.sa_mask);
    sigaddset(&outer_action.sa_mask, SIGUSR1);
    outer_action.sa_flags = SA_RESTART;
    memset(&wake_action, 0, sizeof(wake_action));
    wake_action.sa_handler = on_nested_wakeup;
    sigemptyset(&wake_action.sa_mask);
    if (sigaction(SIGALRM, &outer_action, NULL) != 0 ||
        sigaction(SIGUSR2, &wake_action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &original, NULL) != 0 ||
        pipe(pipefd) != 0)
        return -1;

    nested_wait_kind = kind;
    nested_wait_result = -2;
    nested_wait_errno = 0;
    nested_wait_failed = 0;
    nested_observed_hup = -1;
    nested_observed_alrm = -1;
    nested_observed_usr1 = -1;
    nested_observed_usr2 = -1;
    nested_observed_term = -1;
    nested_wakeup_count = 0;
    nested_ready_fd = pipefd[0];
    nested_target_thread = pthread_self();
    nested_wakeup_signal = SIGUSR2;
    nested_wakeup_delay_ms = 0;
    atomic_store_explicit(&nested_wake_gate, 0, memory_order_relaxed);
    nested_expected_handler_mask = outer_replacement;
    sigaddset(&nested_expected_handler_mask, SIGALRM);
    sigaddset(&nested_expected_handler_mask, SIGUSR1);

    if (kind == NESTED_WAIT_PPOLL || kind == NESTED_WAIT_PSELECT) {
        if (write(pipefd[1], &byte, 1) != 1)
            return -1;
    } else {
        if (pthread_create(&helper, NULL, send_nested_wakeup, NULL) != 0)
            return -1;
        helper_started = 1;
    }
    if (raise(SIGALRM) != 0)
        return -1;
    errno = 0;
    outer_result = ppoll(NULL, 0, &no_wait, &outer_replacement);
    if (helper_started && pthread_join(helper, NULL) != 0)
        return -1;

    if (outer_result != 0 || nested_wait_failed ||
        nested_wait_result == -2 ||
        ((kind == NESTED_WAIT_SIGSUSPEND || kind == NESTED_WAIT_PAUSE) &&
         nested_wakeup_count != 1) ||
        check_restored_mask(&original) != 0) {
        fprintf(
            stderr,
            "nested wait kind=%d: outer=%d inner={result=%d errno=%d "
            "failed=%d wakeups=%d mask={hup=%d alrm=%d usr1=%d usr2=%d "
            "term=%d}}\n",
            kind, outer_result, (int)nested_wait_result,
            (int)nested_wait_errno, (int)nested_wait_failed,
            (int)nested_wakeup_count,
            (int)nested_observed_hup, (int)nested_observed_alrm,
            (int)nested_observed_usr1, (int)nested_observed_usr2,
            (int)nested_observed_term
        );
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }
    nested_wait_kind = NESTED_WAIT_NONE;
    nested_ready_fd = -1;
    if (close(pipefd[0]) != 0 || close(pipefd[1]) != 0)
        return -1;
    return 0;
}

static void *run_pthread_nested_wait(void *result_ptr)
{
    int *result = result_ptr;
    *result = run_nested_wait_case(NESTED_WAIT_PPOLL);
    return NULL;
}

static int run_nested_wait_matrix(void)
{
    pthread_t worker;
    int worker_result = -1;

    for (enum nested_wait kind = NESTED_WAIT_PPOLL;
         kind <= NESTED_WAIT_PAUSE;
         kind++) {
        if (run_nested_wait_case(kind) != 0)
            return -1;
    }
    if (pthread_create(&worker, NULL, run_pthread_nested_wait, &worker_result) != 0 ||
        pthread_join(worker, NULL) != 0 || worker_result != 0) {
        fputs("pthread nested ppoll failed\n", stderr);
        return -1;
    }
    return 0;
}

static int run_nested_same_argument_deadline_case(void)
{
    sigset_t original;
    sigset_t replacement;
    struct sigaction action;
    const struct timespec timeout = { .tv_sec = 0, .tv_nsec = 250000000 };
    struct timespec start;
    struct timespec end;
    struct pollfd pfd;
    int pipefd[2] = { -1, -1 };
    int marker_len;
    int result;
    long duration;

    sigemptyset(&original);
    sigaddset(&original, SIGUSR2);
    sigemptyset(&replacement);
    sigaddset(&replacement, SIGTERM);
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_collision_alarm;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESTART;
    if (sigaction(SIGALRM, &action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &original, NULL) != 0 ||
        pipe(pipefd) != 0)
        return -1;

    marker_len = snprintf(
        deadline_marker,
        sizeof(deadline_marker),
        "TASK16_TIMEOUT_GATE=%lu\n",
        (unsigned long)(uintptr_t)&deadline_gate
    );
    if (marker_len <= 0 || marker_len >= (int)sizeof(deadline_marker))
        return -1;
    deadline_marker_len = (size_t)marker_len;
    atomic_store_explicit(&deadline_gate, 0, memory_order_relaxed);
    nested_wait_failed = 0;
    collision_inner_result = -2;
    collision_inner_ready = 0;
    collision_handler_mask_exact = 0;
    pfd.fd = pipefd[0];
    pfd.events = POLLIN;
    pfd.revents = 0;
    collision_pollfd = &pfd;
    collision_timeout = &timeout;
    collision_replacement = &replacement;
    collision_read_fd = pipefd[0];
    collision_write_fd = pipefd[1];
    nested_expected_handler_mask = replacement;
    sigaddset(&nested_expected_handler_mask, SIGALRM);

    if (mark_wait_about_to_block() != 0 ||
        clock_gettime(CLOCK_MONOTONIC, &start) != 0)
        return -1;
    result = ppoll(&pfd, 1, &timeout, &replacement);
    if (clock_gettime(CLOCK_MONOTONIC, &end) != 0)
        return -1;
    duration = elapsed_ms(start, end);

    if (result != 0 || nested_wait_failed || collision_inner_result != 1 ||
        !collision_inner_ready || !collision_handler_mask_exact ||
        check_restored_mask(&original) != 0 ||
        duration < 250 || duration >= 450) {
        fprintf(
            stderr,
            "nested same-args ppoll: outer=%d elapsed=%ld "
            "inner={result=%d ready=%d mask=%d failed=%d}\n",
            result, duration, (int)collision_inner_result,
            (int)collision_inner_ready, (int)collision_handler_mask_exact,
            (int)nested_wait_failed
        );
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }
    collision_read_fd = -1;
    collision_write_fd = -1;
    if (close(pipefd[0]) != 0 || close(pipefd[1]) != 0)
        return -1;
    return 0;
}

static int run_nested_siglongjmp_cleanup_case(void)
{
    sigset_t jump_mask;
    sigset_t outer_original;
    sigset_t replacement;
    sigset_t later_original;
    struct sigaction outer_action;
    struct sigaction jump_action;
    const struct timespec timeout = { .tv_sec = 0, .tv_nsec = 600000000 };
    struct timespec start;
    struct timespec end;
    int result;
    long duration;

    sigemptyset(&jump_mask);
    sigaddset(&jump_mask, SIGHUP);
    sigemptyset(&outer_original);
    sigaddset(&outer_original, SIGUSR2);
    sigemptyset(&replacement);
    sigaddset(&replacement, SIGTERM);
    sigemptyset(&later_original);
    sigaddset(&later_original, SIGCHLD);
    memset(&outer_action, 0, sizeof(outer_action));
    outer_action.sa_handler = on_nonlocal_outer;
    sigemptyset(&outer_action.sa_mask);
    outer_action.sa_flags = SA_RESTART;
    memset(&jump_action, 0, sizeof(jump_action));
    jump_action.sa_handler = on_nonlocal_jump;
    sigemptyset(&jump_action.sa_mask);
    if (sigaction(SIGALRM, &outer_action, NULL) != 0 ||
        sigaction(SIGUSR1, &jump_action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &jump_mask, NULL) != 0)
        return -1;

    if (sigsetjmp(nonlocal_landing, 1) == 0) {
        if (sigprocmask(SIG_SETMASK, &outer_original, NULL) != 0)
            return -1;
        nested_wait_failed = 0;
        nested_target_thread = pthread_self();
        nested_wakeup_signal = SIGUSR1;
        nested_wakeup_delay_ms = 250;
        atomic_store_explicit(&nested_wake_gate, 0, memory_order_relaxed);
        if (pthread_create(
                &nonlocal_helper_thread,
                NULL,
                send_nested_wakeup,
                NULL
            ) != 0)
            return -1;
        if (mark_wait_about_to_block() != 0)
            return -1;
        (void)ppoll(NULL, 0, &timeout, &replacement);
        nested_wait_failed = 1;
        return -1;
    }

    if (pthread_join(nonlocal_helper_thread, NULL) != 0 || nested_wait_failed ||
        check_restored_mask(&jump_mask) != 0 ||
        sigprocmask(SIG_SETMASK, &later_original, NULL) != 0)
        return -1;
    if (clock_gettime(CLOCK_MONOTONIC, &start) != 0)
        return -1;
    result = ppoll(NULL, 0, &timeout, &replacement);
    if (clock_gettime(CLOCK_MONOTONIC, &end) != 0)
        return -1;
    duration = elapsed_ms(start, end);
    if (result != 0 || duration < 550 || duration >= 850 ||
        check_restored_mask(&later_original) != 0) {
        fprintf(
            stderr,
            "nested siglongjmp follow-on ppoll: result=%d elapsed=%ld "
            "failed=%d\n",
            result, duration, (int)nested_wait_failed
        );
        return -1;
    }
    return 0;
}

static int run_ordinary_longjmp_case(void)
{
    jmp_buf landing;
    sigset_t expected;
    int jump_value;

    sigemptyset(&expected);
    sigaddset(&expected, SIGHUP);
    if (sigprocmask(SIG_SETMASK, &expected, NULL) != 0)
        return -1;

    jump_value = setjmp(landing);
    if (jump_value == 0)
        longjmp(landing, 5);
    if (jump_value != 5 || __wasm_posix_caught_handler_depth() != 0 ||
        check_restored_mask(&expected) != 0) {
        fprintf(
            stderr,
            "ordinary longjmp over-clean: value=%d depth=%lu\n",
            jump_value, __wasm_posix_caught_handler_depth()
        );
        return -1;
    }
    return 0;
}

static int run_siglongjmp_no_mask_case(void)
{
    sigset_t setjmp_mask;
    sigset_t outer_original;
    sigset_t replacement;
    sigset_t later_original;
    struct sigaction action;
    const struct timespec timeout = { .tv_sec = 1, .tv_nsec = 0 };
    const struct timespec no_wait = { 0, 0 };
    int jump_value;
    int later_result;

    sigemptyset(&setjmp_mask);
    sigaddset(&setjmp_mask, SIGHUP);
    sigemptyset(&outer_original);
    sigaddset(&outer_original, SIGUSR2);
    sigemptyset(&replacement);
    sigaddset(&replacement, SIGTERM);
    sigemptyset(&no_mask_landing_mask);
    sigaddset(&no_mask_landing_mask, SIGCHLD);
    sigemptyset(&later_original);
    sigaddset(&later_original, SIGWINCH);
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_no_mask_siglongjmp;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESTART;
    if (sigaction(SIGUSR1, &action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &setjmp_mask, NULL) != 0)
        return -1;

    no_mask_jump_failed = 0;
    no_mask_jump_handler_depth = -1;
    jump_value = sigsetjmp(no_mask_landing, 0);
    if (jump_value == 0) {
        if (sigprocmask(SIG_SETMASK, &outer_original, NULL) != 0)
            return -1;
        nested_wait_failed = 0;
        nested_target_thread = pthread_self();
        nested_wakeup_signal = SIGUSR1;
        nested_wakeup_delay_ms = 0;
        atomic_store_explicit(&nested_wake_gate, 0, memory_order_relaxed);
        if (pthread_create(
                &nonlocal_helper_thread,
                NULL,
                send_nested_wakeup,
                NULL
            ) != 0)
            return -1;
        atomic_store_explicit(&nested_wake_gate, 1, memory_order_release);
        (void)ppoll(NULL, 0, &timeout, &replacement);
        return -1;
    }

    if (pthread_join(nonlocal_helper_thread, NULL) != 0 ||
        jump_value != 9 || nested_wait_failed || no_mask_jump_failed ||
        no_mask_jump_handler_depth != 1 ||
        __wasm_posix_caught_handler_depth() != 0 ||
        check_restored_mask(&no_mask_landing_mask) != 0 ||
        sigprocmask(SIG_SETMASK, &later_original, NULL) != 0)
        return -1;
    later_result = ppoll(NULL, 0, &no_wait, &replacement);
    if (later_result != 0 || check_restored_mask(&later_original) != 0) {
        fprintf(
            stderr,
            "siglongjmp savemask=0: value=%d handler_depth=%d depth=%lu "
            "later=%d failed=%d\n",
            jump_value, (int)no_mask_jump_handler_depth,
            __wasm_posix_caught_handler_depth(), later_result,
            (int)no_mask_jump_failed
        );
        return -1;
    }
    return 0;
}

static int run_generic_longjmp_cleanup_case(void)
{
    sigset_t outer_original;
    sigset_t replacement;
    sigset_t later_original;
    struct sigaction action;
    const struct timespec timeout = { .tv_sec = 1, .tv_nsec = 0 };
    const struct timespec no_wait = { 0, 0 };
    int jump_value;
    int later_result;
    unsigned long final_depth;

    sigemptyset(&generic_landing_mask);
    sigaddset(&generic_landing_mask, SIGHUP);
    sigemptyset(&outer_original);
    sigaddset(&outer_original, SIGUSR2);
    sigemptyset(&replacement);
    sigaddset(&replacement, SIGTERM);
    sigemptyset(&later_original);
    sigaddset(&later_original, SIGCHLD);
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_generic_longjmp;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESTART;
    if (sigaction(SIGALRM, &action, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &generic_landing_mask, NULL) != 0)
        return -1;

    generic_jump_failed = 0;
    generic_jump_handler_depth = -1;
    jump_value = setjmp(generic_landing);
    if (jump_value == 0) {
        if (sigprocmask(SIG_SETMASK, &outer_original, NULL) != 0)
            return -1;
        nested_wait_failed = 0;
        nested_target_thread = pthread_self();
        nested_wakeup_signal = SIGALRM;
        nested_wakeup_delay_ms = 0;
        atomic_store_explicit(&nested_wake_gate, 0, memory_order_relaxed);
        if (pthread_create(
                &nonlocal_helper_thread,
                NULL,
                send_nested_wakeup,
                NULL
            ) != 0)
            return -1;
        atomic_store_explicit(&nested_wake_gate, 1, memory_order_release);
        (void)ppoll(NULL, 0, &timeout, &replacement);
        return -1;
    }

    final_depth = __wasm_posix_caught_handler_depth();
    if (pthread_join(nonlocal_helper_thread, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, &later_original, NULL) != 0)
        return -1;
    later_result = ppoll(NULL, 0, &no_wait, &replacement);
    if (jump_value != 7 || nested_wait_failed || generic_jump_failed ||
        generic_jump_handler_depth != 1 || final_depth != 0 ||
        later_result != 0 || check_restored_mask(&later_original) != 0) {
        fprintf(
            stderr,
            "generic handler longjmp cleanup: value=%d handler_depth=%d "
            "final_depth=%lu later=%d failed=%d\n",
            jump_value, (int)generic_jump_handler_depth, final_depth,
            later_result, (int)generic_jump_failed
        );
        return -1;
    }
    return 0;
}

int main(int argc, char **argv)
{
    int cleanup_failed = 0;
    int use_browser_gate = argc == 2 &&
        strcmp(argv[1], "--browser-gate") == 0;

    if ((argc != 1 && !use_browser_gate) ||
        (use_browser_gate && bind_browser_gate_memory() != 0) ||
        check_wait4_unknown_option() != 0)
        return 2;

    for (enum wait_api api = WAIT_API_PPOLL; api <= WAIT_API_PSELECT; api++) {
        for (enum signal_arrival arrival = SIGNAL_PENDING_BEFORE_ENTRY;
             arrival <= SIGNAL_ARRIVING_WHILE_BLOCKED;
             arrival++) {
            for (int use_replacement_mask = 0;
                 use_replacement_mask <= 1;
                 use_replacement_mask++) {
                for (int restart = 0; restart <= 1; restart++) {
                    if (run_case(api, arrival, use_replacement_mask, restart) != 0)
                        return 2;
                }
            }
        }
    }

    if (run_ppoll_restart_window_case() != 0)
        return 2;
    if (run_ppoll_masked_cancel_case() != 0)
        return 2;
    if (run_ppoll_restart_deadline_case() != 0)
        return 2;
    if (run_pause_cleanup_case() != 0)
        cleanup_failed = 1;
    if (run_sigsuspend_cleanup_case() != 0)
        cleanup_failed = 1;
    if (run_nested_wait_matrix() != 0)
        cleanup_failed = 1;
    if (run_nested_same_argument_deadline_case() != 0)
        cleanup_failed = 1;
    if (run_nested_siglongjmp_cleanup_case() != 0)
        cleanup_failed = 1;
    if (run_ordinary_longjmp_case() != 0)
        cleanup_failed = 1;
    if (run_siglongjmp_no_mask_case() != 0)
        cleanup_failed = 1;
    if (run_generic_longjmp_cleanup_case() != 0)
        cleanup_failed = 1;
    if (cleanup_failed)
        return 2;

    puts("PASS ppoll/pselect signal mask interruption matrix");
    return 0;
}
