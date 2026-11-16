#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int foo_counter = 41;
static int ctor_ran;

__attribute__((constructor)) static void foo_init(void) {
    ctor_ran = 1;
    /* qsort is never referenced by main.c: the executable must still
     * provide it because this library imports it. */
}

static int cmp(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }

int foo_ctor_ran(void) { return ctor_ran; }

int foo(int x) {
    int v[3] = {3, 1, 2};
    qsort(v, 3, sizeof v[0], cmp);
    printf("libfoo: foo(%d) counter=%d sorted=%d%d%d\n", x, foo_counter, v[0], v[1], v[2]);
    return x + foo_counter;
}

int foo_apply(int (*fn)(int), int x) { return fn(x); }

#ifndef NO_LIB_FORK
#include <unistd.h>
int foo_fork_child(int x) {
    pid_t pid = fork();
    if (pid == 0) {
        printf("lib child: foo(%d)=%d\n", x, foo(x));
        fflush(stdout);
        _exit(3);
    }
    return pid;
}
#endif
