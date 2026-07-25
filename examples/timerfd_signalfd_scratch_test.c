#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/signalfd.h>
#include <sys/timerfd.h>
#include <unistd.h>

struct guarded_timer {
    unsigned char before[16];
    struct itimerspec value;
    unsigned char after[16];
};

static void init_guard(struct guarded_timer *guard)
{
    memset(guard->before, 0xa5, sizeof(guard->before));
    memset(&guard->value, 0, sizeof(guard->value));
    memset(guard->after, 0x5a, sizeof(guard->after));
}

static int guard_is_intact(const struct guarded_timer *guard)
{
    size_t i;
    for (i = 0; i < sizeof(guard->before); i++)
        if (guard->before[i] != 0xa5) return 0;
    for (i = 0; i < sizeof(guard->after); i++)
        if (guard->after[i] != 0x5a) return 0;
    return 1;
}

int main(void)
{
    struct guarded_timer next;
    struct guarded_timer old;
    struct guarded_timer current;
    sigset_t mask;
    int timer_fd;
    int signal_fd;

    init_guard(&next);
    init_guard(&old);
    init_guard(&current);

    timer_fd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
    if (timer_fd < 0) {
        perror("timerfd_create");
        return 1;
    }
    if (timerfd_settime(timer_fd, 0, &next.value, &old.value) != 0) {
        perror("timerfd_settime");
        return 1;
    }
    if (timerfd_gettime(timer_fd, &current.value) != 0) {
        perror("timerfd_gettime");
        return 1;
    }
    if (!guard_is_intact(&next) || !guard_is_intact(&old)
        || !guard_is_intact(&current)) {
        fprintf(stderr, "timerfd scratch transfer crossed caller capacity\n");
        return 1;
    }
    close(timer_fd);
    puts("timerfd scratch guards: PASS");

    if (sigemptyset(&mask) != 0 || sigaddset(&mask, SIGUSR1) != 0
        || sigprocmask(SIG_BLOCK, &mask, NULL) != 0) {
        perror("signal mask setup");
        return 1;
    }
    signal_fd = signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);
    if (signal_fd < 0) {
        perror("signalfd");
        return 1;
    }
    close(signal_fd);
    puts("signalfd scratch mask: PASS");
    puts("ALL TESTS PASSED");
    return 0;
}
