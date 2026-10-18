// poll() must leave the caller's pollfd array intact when it times out.
//
// A poll that outlives its first pass is completed by the host later, from a
// timer, without running the syscall again. That completion used to copy the
// kernel's shared scratch buffer back over the caller's array — and by then
// the scratch holds whatever syscall ran last, in any process. The caller
// then polls a garbage descriptor forever: dbus-daemon's main loop printed
// "invalid request, socket fd 12 not open" thousands of times per second
// after its 30-second auth timeout expired.
//
// The child keeps foreign syscall data in the scratch while the parent's poll
// times out on a pipe nobody writes to.
//
// Expected output on PASS:
//   PARENT: rc=0 fd=<fd> events=1 revents=0
//   PASS

#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    int quiet[2];
    if (pipe(quiet) != 0) {
        printf("FAIL: pipe errno=%d\n", errno);
        return 1;
    }

    pid_t child = fork();
    if (child < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }
    if (child == 0) {
        // Every stat() leaves a struct stat in the kernel's scratch buffer.
        struct stat st;
        for (;;) {
            stat("/", &st);
        }
    }

    struct pollfd pfd = {.fd = quiet[0], .events = POLLIN, .revents = 0};
    int rc = poll(&pfd, 1, 300);
    printf("PARENT: rc=%d fd=%d events=%d revents=%d\n",
           rc, pfd.fd, pfd.events, pfd.revents);

    kill(child, SIGKILL);
    waitpid(child, NULL, 0);

    if (rc != 0 || pfd.fd != quiet[0] || pfd.events != POLLIN || pfd.revents != 0) {
        printf("FAIL: poll scribbled on the pollfd array\n");
        return 1;
    }
    printf("PASS\n");
    return 0;
}
