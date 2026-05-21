// K-06 — fork() from a C++ destructor (RAII unwinding triggers fork).
//
// Coverage matrix: unusual but legal C++ pattern. Verifies that
// fork-instrument handles fork-path calls reached via destructor
// invocation. The destructor is called when the object goes out
// of scope; fork() inside the destructor must work the same as
// any other fork-path call.
//
// Expected output on PASS:
//   IN_SCOPE
//   IN_DTOR
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: K-06

#include <cstdio>
#include <cstdlib>
#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>

static int g_child_pid = -1;

class Forker {
public:
    Forker() {
        printf("IN_SCOPE\n");
        fflush(stdout);
    }
    ~Forker() {
        printf("IN_DTOR\n");
        printf("PRE_FORK\n");
        fflush(stdout);

        pid_t pid = fork();
        if (pid < 0) {
            printf("FAIL: fork errno=%d\n", errno);
            g_child_pid = -1;
            return;
        }
        if (pid == 0) {
            printf("CHILD: ok\n");
            fflush(stdout);
            _exit(0);
        }
        printf("PARENT: child=%d\n", pid);
        fflush(stdout);
        g_child_pid = pid;
    }
};

int main() {
    {
        Forker f;
        (void)f;
        // Object goes out of scope here, dtor runs, fork happens.
    }
    if (g_child_pid < 0) {
        printf("FAIL: dtor did not record child pid\n");
        return 1;
    }
    int status = 0;
    if (waitpid(g_child_pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: K-06\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
