// A handler installed without SA_RESTART must let the blocking syscall it
// interrupts fail with EINTR.
//
// Outside poll/select the kernel parks a blocking syscall whenever it would
// block, without reading the handler's flags, so the park alone cannot tell
// the glue whether to re-issue. Only the host's restart flag can, and it is
// set for an SA_RESTART handler. This is the shutdown pattern that depends
// on it: a
// handler sets a flag, the blocking wait fails with EINTR, and the loop sees
// the flag and exits. A syscall that restarts instead never lets it run.
//
// Expected output on PASS:
//   CHILD: sent SIGUSR2
//   HANDLER: ran
//   PASS: signal-no-restart

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int idle_pipe[2];
static volatile sig_atomic_t handled = 0;

static void on_sigusr2(int signum) {
    (void)signum;
    handled = 1;
}

int main(void) {
    if (pipe(idle_pipe) != 0) {
        printf("FAIL: pipe errno=%d\n", errno);
        return 1;
    }

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_sigusr2;
    sa.sa_flags = 0;
    if (sigaction(SIGUSR2, &sa, NULL) != 0) {
        printf("FAIL: sigaction errno=%d\n", errno);
        return 1;
    }

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

    // Nothing ever writes to idle_pipe, so only the signal ends this read.
    // read() has no timeout, so the kernel parks it rather than failing it
    // early the way it does a poll() that carries a sigmask — the park is
    // what puts the restart flag in play.
    char byte = 0;
    ssize_t amount = read(idle_pipe[0], &byte, 1);
    int saved = errno;

    if (amount != -1 || saved != EINTR) {
        printf("FAIL: read returned %zd errno=%d, expected -1 EINTR\n", amount, saved);
        return 1;
    }
    if (!handled) {
        printf("FAIL: read failed with EINTR but the handler never ran\n");
        return 1;
    }
    printf("HANDLER: ran\n");

    waitpid(child, NULL, 0);
    printf("PASS: signal-no-restart\n");
    return 0;
}
