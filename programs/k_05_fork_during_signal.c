// K-05 — fork() with a pending signal queued just before.
//
// Coverage matrix: signal-during-fork interaction. The signal must
// either fire before fork() returns (and be delivered to both
// parent and child consistently) or be deferred. The kernel's
// signal-pending mechanism must not corrupt fork()'s unwind/rewind
// state.
//
// Expected output on PASS:
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: K-05

#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>

static volatile sig_atomic_t signal_fired = 0;

static void sigusr1_handler(int sig) {
    (void)sig;
    signal_fired = 1;
}

int main(void) {
    struct sigaction sa = {0};
    sa.sa_handler = sigusr1_handler;
    sigemptyset(&sa.sa_mask);
    if (sigaction(SIGUSR1, &sa, NULL) < 0) {
        printf("FAIL: sigaction errno=%d\n", errno);
        return 1;
    }

    // Block SIGUSR1 so it stays pending across fork.
    sigset_t set, oldset;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR1);
    if (sigprocmask(SIG_BLOCK, &set, &oldset) < 0) {
        printf("FAIL: sigprocmask block errno=%d\n", errno);
        return 1;
    }

    // Queue SIGUSR1 to self.
    if (kill(getpid(), SIGUSR1) < 0) {
        printf("FAIL: kill errno=%d\n", errno);
        return 1;
    }

    printf("PRE_FORK\n");
    fflush(stdout);

    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        // Unblock signal so it fires.
        sigprocmask(SIG_SETMASK, &oldset, NULL);
        printf("CHILD: ok\n");
        fflush(stdout);
        _exit(0);
    }
    sigprocmask(SIG_SETMASK, &oldset, NULL);
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: K-05\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
