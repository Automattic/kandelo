#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

extern int foo(int);
extern int foo_counter;
#ifndef NO_LIB_FORK
extern int foo_fork_child(int);
#endif

int main(int argc, char **argv) {
    foo_counter = 100;
    fflush(stdout);
#ifndef NO_LIB_FORK
    if (argc > 1) {
        /* fork() called from inside the shared library, reached through
         * the executable's import of foo_fork_child. */
#ifdef VIA_POINTER
        int (*volatile fp)(int) = foo_fork_child;
        int r = fp(5);
#else
        int r = foo_fork_child(5);
#endif
        if (r == 0) _exit(0);
        int st = 0;
        waitpid(r, &st, 0);
        printf("parent: lib-fork child status=%d\n", WEXITSTATUS(st));
        return 0;
    }
#endif
    pid_t pid = fork();
    if (pid == 0) {
        foo_counter += 1;
        printf("child: foo(1)=%d\n", foo(1));
        fflush(stdout);
        _exit(foo_counter == 101 ? 7 : 1);
    }
    int st = 0;
    waitpid(pid, &st, 0);
    printf("parent: child status=%d counter=%d foo(1)=%d\n", WEXITSTATUS(st), foo_counter, foo(1));
    return 0;
}
