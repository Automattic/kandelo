#define _GNU_SOURCE

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/time.h>
#include <time.h>

static volatile sig_atomic_t alarm_count;

static void on_alarm(int signo)
{
    (void)signo;
    alarm_count++;
}

static int arm_alarm(long usec)
{
    struct itimerval timer = {
        .it_value = { .tv_sec = 0, .tv_usec = usec },
    };
    return setitimer(ITIMER_REAL, &timer, NULL);
}

int main(void)
{
    struct sigaction action = { .sa_handler = on_alarm };
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGALRM, &action, NULL) != 0) {
        perror("sigaction");
        return 2;
    }

    if (arm_alarm(20 * 1000) != 0) {
        perror("setitimer(select)");
        return 3;
    }
    errno = 0;
    if (select(0, NULL, NULL, NULL, NULL) != -1 || errno != EINTR || alarm_count != 1) {
        fprintf(stderr, "select result mismatch: errno=%d alarms=%d\n",
                errno, (int)alarm_count);
        return 4;
    }

    sigset_t alarm_set;
    sigset_t old_set;
    sigset_t empty_set;
    sigset_t restored_set;
    sigemptyset(&alarm_set);
    sigaddset(&alarm_set, SIGALRM);
    sigemptyset(&empty_set);
    if (sigprocmask(SIG_BLOCK, &alarm_set, &old_set) != 0) {
        perror("sigprocmask(block)");
        return 5;
    }
    if (arm_alarm(20 * 1000) != 0) {
        perror("setitimer(pselect)");
        return 6;
    }

    const struct timespec timeout = { .tv_sec = 5, .tv_nsec = 0 };
    errno = 0;
    if (pselect(0, NULL, NULL, NULL, &timeout, &empty_set) != -1 ||
        errno != EINTR || alarm_count != 2) {
        fprintf(stderr, "pselect result mismatch: errno=%d alarms=%d\n",
                errno, (int)alarm_count);
        return 7;
    }
    if (sigprocmask(SIG_SETMASK, NULL, &restored_set) != 0 ||
        !sigismember(&restored_set, SIGALRM)) {
        fputs("pselect did not restore the caller signal mask\n", stderr);
        return 8;
    }
    if (sigprocmask(SIG_SETMASK, &old_set, NULL) != 0) {
        perror("sigprocmask(restore)");
        return 9;
    }

    action.sa_handler = SIG_IGN;
    if (sigaction(SIGALRM, &action, NULL) != 0) {
        perror("sigaction(ignore)");
        return 10;
    }
    if (arm_alarm(20 * 1000) != 0) {
        perror("setitimer(ignored select)");
        return 11;
    }
    struct timeval ignored_timeout = { .tv_sec = 0, .tv_usec = 50 * 1000 };
    errno = 0;
    if (select(0, NULL, NULL, NULL, &ignored_timeout) != 0 ||
        errno != 0 || alarm_count != 2) {
        fprintf(stderr, "ignored select mismatch: errno=%d alarms=%d\n",
                errno, (int)alarm_count);
        return 12;
    }

    puts("PASS select and pselect EINTR");
    return 0;
}
