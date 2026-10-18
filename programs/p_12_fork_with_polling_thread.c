// P-12 — fork() + child exit while another thread is parked in poll().
//
// The child's exit queues SIGCHLD on the parent. The host then wakes
// every poll parked for that pid, and a poll that is still not ready
// re-registers itself as it retries. Walking the live registration map
// to do that never terminates — the iterator also visits the entry the
// retry just added — and the kernel worker stops servicing every
// process on the machine.
//
// Waybar reaches this through wordexp(): its signal thread sits in poll
// while musl's wordexp() forks /bin/sh, so the bar hangs before it ever
// reads its config.
//
// POSIX semantics: the parent reaps the child; the polling thread keeps
// waiting because nothing is ever written to the pipe. What this fixture
// asserts is that the machine still runs after the child exits.
//
// Expected output on PASS:
//   THREAD_POLLING
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   REAPED
//   PASS: P-12

#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static int pipefd[2];
static volatile int polling = 0;

static void on_sigchld(int signum) { (void)signum; }

static void *poller(void *arg) {
    (void)arg;
    struct pollfd pfd = {.fd = pipefd[0], .events = POLLIN, .revents = 0};
    printf("THREAD_POLLING\n");
    fflush(stdout);
    polling = 1;
    poll(&pfd, 1, -1);
    return NULL;
}

int main(void) {
    if (pipe(pipefd) != 0) {
        printf("FAIL: pipe errno=%d\n", errno);
        return 1;
    }
    signal(SIGCHLD, on_sigchld);

    pthread_t t;
    if (pthread_create(&t, NULL, poller, NULL) != 0) {
        printf("FAIL: pthread_create\n");
        return 1;
    }
    while (!polling) {
    }
    // The flag is set before poll() enters the kernel; spin long enough
    // for the host to park the retry that the child's exit must wake.
    for (volatile long i = 0; i < 4000000; i++) {
    }

    printf("PRE_FORK\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        printf("CHILD: ok\n");
        fflush(stdout);
        _exit(0);
    }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);

    int status = 0;
    if (waitpid(pid, &status, 0) != pid) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    printf("REAPED\n");
    printf("PASS: P-12\n");
    return 0;
}
