#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/epoll.h>
#include <sys/timerfd.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"FAIL %d errno=%d: %s\n",__LINE__,errno,#e);_Exit(1); } } while (0)
static volatile sig_atomic_t notified;
static _Atomic int ready, word;
static void notice(int sig) { (void)sig; notified = 1; }
static void *park(void *arg) {
    (void)arg;
    atomic_store(&ready, 1);
    __builtin_wasm_memory_atomic_wait32((int *)&word, 0, -1);
    return NULL;
}
static double now(void) {
    struct timespec t; CHECK(clock_gettime(CLOCK_MONOTONIC, &t) == 0);
    return t.tv_sec + t.tv_nsec / 1e9;
}
int main(void) {
    sigset_t blocked, during_wait;
    sigemptyset(&blocked); sigaddset(&blocked, SIGCHLD); sigemptyset(&during_wait);
    CHECK(sigprocmask(SIG_BLOCK, &blocked, NULL) == 0);
    struct sigaction sa = { .sa_handler = notice }; sigemptyset(&sa.sa_mask);
    CHECK(sigaction(SIGCHLD, &sa, NULL) == 0);
    int ep = epoll_create1(EPOLL_CLOEXEC), timer = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
    CHECK(ep >= 0 && timer >= 0);
    struct epoll_event interest = { .events = EPOLLIN, .data.fd = timer };
    CHECK(epoll_ctl(ep, EPOLL_CTL_ADD, timer, &interest) == 0);
    struct itimerspec tick = { .it_value = { .tv_nsec = 20000000 }, .it_interval = { .tv_nsec = 20000000 } };
    CHECK(timerfd_settime(timer, 0, &tick, NULL) == 0);
    for (int cycle = 0; cycle < 64; cycle++) {
        notified = 0;
        pid_t child = fork(); CHECK(child >= 0);
        if (!child) {
            pthread_t thread; CHECK(pthread_create(&thread, NULL, park, NULL) == 0);
            while (!atomic_load(&ready)) sched_yield();
            _Exit(17);
        }
        double end = now() + 5;
        while (!notified && now() < end) {
            struct epoll_event event;
            int count = epoll_pwait(ep, &event, 1, 100, &during_wait);
            CHECK(count >= 0 || errno == EINTR);
            if (count > 0) { uint64_t elapsed; CHECK(read(timer, &elapsed, sizeof(elapsed)) == sizeof(elapsed)); }
        }
        CHECK(notified);
        int status = 0; pid_t observed = waitpid(child, &status, WNOHANG);
        if (observed == 0) {
            printf("EARLY_SIGCHLD cycle=%d child=%d waitpid=0\n", cycle, child); fflush(stdout);
            CHECK(waitpid(child, &status, 0) == child);
            return 11;
        }
        CHECK(observed == child && WIFEXITED(status) && WEXITSTATUS(status) == 17);
    }
    CHECK(close(timer) == 0 && close(ep) == 0);
    puts("grouped-sdk-sigchld-wnohang PASS 64 exact child exits");
    return 0;
}
