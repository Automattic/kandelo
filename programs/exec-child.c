/*
 * exec-child.c — Target program for exec tests.
 * Prints its argv and selected env vars to verify exec passed them correctly.
 */
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char *argv[]) {
    printf("argc=%d\n", argc);
    for (int i = 0; i < argc; i++)
        printf("argv[%d]=%s\n", i, argv[i]);

    const char *foo = getenv("FOO");
    if (foo) printf("FOO=%s\n", foo);

    const char *test = getenv("TEST");
    if (test) printf("TEST=%s\n", test);

    const char *from = getenv("FROM");
    if (from) printf("FROM=%s\n", from);

    /* Use a distinctive exit code so tests can verify the right program ran */
    return 42;
}
