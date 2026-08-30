// A signal sent from another process must reach the handler of a
// multi-threaded target.
//
// This is Waybar's shape (src/main.cpp catchSignals): a handler writes
// the signal number to a pipe, a dedicated thread blocks in read() on
// that pipe, and the main thread blocks in poll(). The omarchy theme
// switch sends SIGUSR2 and expects the bar to reload its stylesheet.
//
// Expected output on PASS:
//   THREAD_READING
//   CHILD: sent SIGUSR2
//   THREAD: signum=12
//   MAIN: woken
//   PASS: signal-to-threaded

#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static int signal_pipe[2];
static int wake_pipe[2];
static volatile int reading = 0;

static void on_sigusr2(int signum) { write(signal_pipe[1], &signum, sizeof(int)); }

static void *signal_thread(void *arg) {
    (void)arg;
    printf("THREAD_READING\n");
    fflush(stdout);
    reading = 1;
    for (;;) {
        int signum = 0;
        ssize_t amount = read(signal_pipe[0], &signum, sizeof(int));
        if (amount < 0 && errno == EINTR) continue;
        if (amount != (ssize_t)sizeof(int)) return NULL;
        printf("THREAD: signum=%d\n", signum);
        fflush(stdout);
        write(wake_pipe[1], "x", 1);
        return NULL;
    }
}

int main(void) {
    if (pipe(signal_pipe) != 0 || pipe(wake_pipe) != 0) {
        printf("FAIL: pipe errno=%d\n", errno);
        return 1;
    }
    signal(SIGUSR2, on_sigusr2);

    pid_t self = getpid();
    pid_t child = fork();
    if (child < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }
    if (child == 0) {
        usleep(300000);
        kill(self, SIGUSR2);
        printf("CHILD: sent SIGUSR2\n");
        fflush(stdout);
        _exit(0);
    }

    pthread_t thread;
    if (pthread_create(&thread, NULL, signal_thread, NULL) != 0) {
        printf("FAIL: pthread_create\n");
        return 1;
    }
    while (!reading) {
    }

    struct pollfd pfd = {.fd = wake_pipe[0], .events = POLLIN, .revents = 0};
    int ready = 0;
    for (;;) {
        ready = poll(&pfd, 1, 10000);
        if (ready < 0 && errno == EINTR) continue;
        break;
    }
    if (ready <= 0) {
        printf("FAIL: poll ready=%d errno=%d\n", ready, errno);
        return 1;
    }
    printf("MAIN: woken\n");

    pthread_join(thread, NULL);
    waitpid(child, NULL, 0);
    printf("PASS: signal-to-threaded\n");
    return 0;
}
