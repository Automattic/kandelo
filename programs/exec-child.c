/*
 * exec-child.c — Target program for exec tests.
 * Prints its argv and selected env vars to verify exec passed them correctly.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>

int main(int argc, char *argv[]) {
    printf("argc=%d\n", argc);
    for (int i = 0; i < argc; i++)
        printf("argv[%d]=%s\n", i, argv[i]);
    printf("program_invocation_name=%s\n", program_invocation_name);
    printf("program_invocation_short_name=%s\n", program_invocation_short_name);

    const char *foo = getenv("FOO");
    if (foo) printf("FOO=%s\n", foo);

    const char *test = getenv("TEST");
    if (test) printf("TEST=%s\n", test);

    const char *from = getenv("FROM");
    if (from) printf("FROM=%s\n", from);

    /* Use a distinctive exit code so tests can verify the right program ran */
    return 42;
}
