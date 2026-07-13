#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

struct callback_state {
    _Atomic int count;
    _Atomic int value;
    _Atomic uintptr_t thread;
    int expected;
};

struct wait_state {
    _Atomic int ready;
    int result;
    int error;
    long elapsed_ms;
    int signum;
};

static void timer_callback(union sigval value)
{
    struct callback_state *state = value.sival_ptr;
    atomic_store_explicit(&state->value, state->expected, memory_order_relaxed);
    atomic_store_explicit(
        &state->thread, (uintptr_t)pthread_self(), memory_order_relaxed);
    atomic_fetch_add_explicit(&state->count, 1, memory_order_release);
}

static void noop_callback(union sigval value)
{
    (void)value;
}

static int arm_thread_timer(
    timer_t *timer, struct callback_state *state, int value, long nanoseconds)
{
    struct sigevent event;
    struct itimerspec timeout;

    memset(&event, 0, sizeof(event));
    state->expected = value;
    event.sigev_notify = SIGEV_THREAD;
    event.sigev_notify_function = timer_callback;
    event.sigev_value.sival_ptr = state;

    if (timer_create(CLOCK_MONOTONIC, &event, timer) != 0) {
        perror("timer_create");
        return -1;
    }

    memset(&timeout, 0, sizeof(timeout));
    timeout.it_value.tv_nsec = nanoseconds;
    if (timer_settime(*timer, 0, &timeout, NULL) != 0) {
        perror("timer_settime");
        timer_delete(*timer);
        return -1;
    }

    return 0;
}

static long elapsed_milliseconds(
    const struct timespec *start, const struct timespec *end)
{
    return (end->tv_sec - start->tv_sec) * 1000
        + (end->tv_nsec - start->tv_nsec) / 1000000;
}

static void *finite_signal_wait(void *argument)
{
    struct wait_state *state = argument;
    const struct timespec timeout = {
        .tv_sec = 1,
        .tv_nsec = 200 * 1000 * 1000,
    };
    struct timespec start;
    struct timespec end;
    sigset_t set;

    sigemptyset(&set);
    sigaddset(&set, state->signum);
    pthread_sigmask(SIG_BLOCK, &set, NULL);
    atomic_store_explicit(&state->ready, 1, memory_order_release);
    clock_gettime(CLOCK_MONOTONIC, &start);
    state->result = sigtimedwait(&set, NULL, &timeout);
    state->error = errno;
    clock_gettime(CLOCK_MONOTONIC, &end);
    state->elapsed_ms = elapsed_milliseconds(&start, &end);
    return NULL;
}

static int test_wait_deadline(void)
{
    const int signum = SIGRTMIN + 2;
    const struct timespec settle = {.tv_nsec = 20 * 1000 * 1000};
    struct wait_state first = {.signum = signum};
    struct wait_state second = {.signum = signum};
    struct sigevent event;
    struct itimerspec timeout = {0};
    pthread_t first_thread;
    pthread_t second_thread;
    sigset_t set;
    sigset_t old_set;
    timer_t timer;

    sigemptyset(&set);
    sigaddset(&set, signum);
    if (pthread_sigmask(SIG_BLOCK, &set, &old_set) != 0)
        return -1;
    if (pthread_create(&first_thread, NULL, finite_signal_wait, &first) != 0) {
        fputs("pthread_create first finite wait failed\n", stderr);
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }
    if (pthread_create(&second_thread, NULL, finite_signal_wait, &second) != 0) {
        fputs("pthread_create second finite wait failed\n", stderr);
        pthread_join(first_thread, NULL);
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }

    for (int attempt = 0; attempt < 100; attempt++) {
        if (atomic_load_explicit(&first.ready, memory_order_acquire)
            && atomic_load_explicit(&second.ready, memory_order_acquire))
            break;
        nanosleep(&settle, NULL);
    }
    nanosleep(&settle, NULL);

    memset(&event, 0, sizeof(event));
    event.sigev_notify = SIGEV_SIGNAL;
    event.sigev_signo = signum;
    if (timer_create(CLOCK_MONOTONIC, &event, &timer) != 0) {
        perror("timer_create deadline");
        pthread_join(first_thread, NULL);
        pthread_join(second_thread, NULL);
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }
    timeout.it_value.tv_nsec = 400 * 1000 * 1000;
    if (timer_settime(timer, 0, &timeout, NULL) != 0) {
        perror("timer_settime deadline");
        timer_delete(timer);
        pthread_join(first_thread, NULL);
        pthread_join(second_thread, NULL);
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }

    pthread_join(first_thread, NULL);
    pthread_join(second_thread, NULL);
    timer_delete(timer);
    pthread_sigmask(SIG_SETMASK, &old_set, NULL);

    struct wait_state *delivered = first.result == signum ? &first : &second;
    struct wait_state *expired = first.result == signum ? &second : &first;
    if (delivered->result != signum || expired->result != -1
        || expired->error != EAGAIN || expired->elapsed_ms < 1000
        || expired->elapsed_ms >= 1500) {
        fprintf(stderr,
            "finite waits: first=%d/%d/%ldms second=%d/%d/%ldms\n",
            first.result, first.error, first.elapsed_ms,
            second.result, second.error, second.elapsed_ms);
        return -1;
    }

    printf("WAIT_DEADLINE: delivered=%ldms timeout=%ldms\n",
        delivered->elapsed_ms, expired->elapsed_ms);
    return 0;
}

static int test_timer_helper_reclamation(void)
{
    const struct timespec yield = {.tv_nsec = 15 * 1000 * 1000};
    struct sigevent event;

    memset(&event, 0, sizeof(event));
    event.sigev_notify = SIGEV_THREAD;
    event.sigev_notify_function = noop_callback;

    for (int iteration = 0; iteration < 24; iteration++) {
        timer_t timer;
        if (timer_create(CLOCK_MONOTONIC, &event, &timer) != 0) {
            fprintf(stderr, "timer helper churn failed at %d: %s\n",
                iteration, strerror(errno));
            return -1;
        }
        if (timer_delete(timer) != 0) {
            fprintf(stderr, "timer helper delete failed at %d: %s\n",
                iteration, strerror(errno));
            return -1;
        }
        nanosleep(&yield, NULL);
    }

    puts("HELPER_CHURN: 24");
    return 0;
}

static int test_signal_timer(void)
{
    const int signum = SIGRTMIN + 1;
    const struct timespec collect_expirations = {
        .tv_nsec = 80 * 1000 * 1000,
    };
    struct sigevent event;
    struct itimerspec schedule;
    struct itimerspec disarm = {0};
    sigset_t set;
    sigset_t old_set;
    siginfo_t info;
    timer_t timer;

    sigemptyset(&set);
    sigaddset(&set, signum);
    if (pthread_sigmask(SIG_BLOCK, &set, &old_set) != 0) {
        fputs("pthread_sigmask failed\n", stderr);
        return -1;
    }

    memset(&event, 0, sizeof(event));
    event.sigev_notify = SIGEV_SIGNAL;
    event.sigev_signo = signum;
    event.sigev_value.sival_int = 77;
    if (timer_create(CLOCK_MONOTONIC, &event, &timer) != 0) {
        perror("timer_create SIGEV_SIGNAL");
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }

    memset(&schedule, 0, sizeof(schedule));
    schedule.it_value.tv_nsec = 5 * 1000 * 1000;
    schedule.it_interval.tv_nsec = 5 * 1000 * 1000;
    if (timer_settime(timer, 0, &schedule, NULL) != 0) {
        perror("timer_settime SIGEV_SIGNAL");
        timer_delete(timer);
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }

    nanosleep(&collect_expirations, NULL);
    if (timer_settime(timer, 0, &disarm, NULL) != 0) {
        perror("timer disarm");
        timer_delete(timer);
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }

    memset(&info, 0, sizeof(info));
    if (sigwaitinfo(&set, &info) != signum) {
        perror("sigwaitinfo");
        timer_delete(timer);
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }

    const int overrun = timer_getoverrun(timer);
    const int timer_id = (int)(intptr_t)timer;
    if (info.si_code != SI_TIMER || info.si_value.sival_int != 77
        || info.si_timerid != timer_id || info.si_overrun < 1
        || overrun != info.si_overrun) {
        fprintf(stderr,
            "timer siginfo: code=%d value=%d timer=%d/%d overrun=%d/%d\n",
            info.si_code, info.si_value.sival_int, info.si_timerid, timer_id,
            info.si_overrun, overrun);
        timer_delete(timer);
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }

    memset(&schedule, 0, sizeof(schedule));
    schedule.it_value.tv_nsec = 10 * 1000 * 1000;
    if (timer_settime(timer, 0, &schedule, NULL) != 0) {
        perror("timer rearm");
        timer_delete(timer);
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }
    memset(&info, 0, sizeof(info));
    if (sigwaitinfo(&set, &info) != signum || info.si_code != SI_TIMER
        || info.si_value.sival_int != 77 || info.si_timerid != timer_id
        || info.si_overrun != 0 || timer_getoverrun(timer) != 0) {
        fprintf(stderr, "timer overrun did not reset: info=%d current=%d\n",
            info.si_overrun, timer_getoverrun(timer));
        timer_delete(timer);
        pthread_sigmask(SIG_SETMASK, &old_set, NULL);
        return -1;
    }

    timer_delete(timer);
    pthread_sigmask(SIG_SETMASK, &old_set, NULL);
    printf("SIGNAL_TIMER: code=%d value=%d timer=%d overrun=%d reset=0\n",
        info.si_code, info.si_value.sival_int, info.si_timerid, overrun);
    return 0;
}

int main(void)
{
    struct callback_state first = {0};
    struct callback_state second = {0};
    timer_t first_timer;
    timer_t second_timer;
    const uintptr_t main_thread = (uintptr_t)pthread_self();
    const struct timespec poll_interval = {.tv_nsec = 5 * 1000 * 1000};
    struct timespec delete_start;
    struct timespec delete_end;

    if (arm_thread_timer(&first_timer, &first, 41, 20 * 1000 * 1000) != 0)
        return 1;
    if (arm_thread_timer(&second_timer, &second, 42, 25 * 1000 * 1000) != 0) {
        timer_delete(first_timer);
        return 1;
    }

    for (int attempt = 0; attempt < 400; attempt++) {
        if (atomic_load_explicit(&first.count, memory_order_acquire) == 1
            && atomic_load_explicit(&second.count, memory_order_acquire) == 1)
            break;
        nanosleep(&poll_interval, NULL);
    }

    clock_gettime(CLOCK_MONOTONIC, &delete_start);
    if (timer_delete(first_timer) != 0 || timer_delete(second_timer) != 0) {
        perror("timer_delete SIGEV_THREAD");
        return 2;
    }
    clock_gettime(CLOCK_MONOTONIC, &delete_end);
    const long delete_ms = elapsed_milliseconds(&delete_start, &delete_end);

    const int first_count = atomic_load_explicit(&first.count, memory_order_acquire);
    const int second_count = atomic_load_explicit(&second.count, memory_order_acquire);
    const int first_value = atomic_load_explicit(&first.value, memory_order_relaxed);
    const int second_value = atomic_load_explicit(&second.value, memory_order_relaxed);
    const uintptr_t first_thread = atomic_load_explicit(&first.thread, memory_order_relaxed);
    const uintptr_t second_thread = atomic_load_explicit(&second.thread, memory_order_relaxed);

    if (first_count != 1 || second_count != 1) {
        fprintf(stderr, "callback counts: first=%d second=%d\n", first_count, second_count);
        return 3;
    }
    if (first_value != 41 || second_value != 42) {
        fprintf(stderr, "callback values: first=%d second=%d\n", first_value, second_value);
        return 4;
    }
    if (first_thread == 0 || second_thread == 0
        || first_thread == main_thread || second_thread == main_thread) {
        fprintf(stderr, "callbacks did not run on timer helper threads\n");
        return 5;
    }
    if (delete_ms >= 300) {
        fprintf(stderr, "timer_delete helper wake took %ldms\n", delete_ms);
        return 6;
    }

    printf("CALLBACKS: first=%d/%d second=%d/%d delete=%ldms\n",
        first_count, first_value, second_count, second_value, delete_ms);
    if (test_signal_timer() != 0)
        return 7;
    if (test_wait_deadline() != 0)
        return 8;
    if (test_timer_helper_reclamation() != 0)
        return 9;
    puts("PASS");
    return 0;
}
