/*
 * putenv_test.c — Test that setenv/getenv/putenv/unsetenv work
 * and that environment variables populated by the kernel at startup
 * are visible to getenv().
 *
 * Expected usage: the host sets HOME=/home/test and PATH=/usr/bin
 * in proc.environ before calling _start.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv)
{
    /* 1. Test startup env population — host should have set HOME and PATH */
    const char *home = getenv("HOME");
    if (home) {
        printf("HOME=%s\n", home);
    } else {
        printf("HOME=<not set>\n");
    }

    const char *path = getenv("PATH");
    if (path) {
        printf("PATH=%s\n", path);
    } else {
        printf("PATH=<not set>\n");
    }

    /* 2. Test setenv */
    setenv("MY_VAR", "hello", 1);
    const char *my_var = getenv("MY_VAR");
    printf("MY_VAR=%s\n", my_var ? my_var : "<not set>");

    /* 3. Test setenv overwrite */
    setenv("MY_VAR", "world", 1);
    my_var = getenv("MY_VAR");
    printf("MY_VAR=%s\n", my_var ? my_var : "<not set>");

    /* 4. Test setenv no-overwrite */
    setenv("MY_VAR", "ignored", 0);
    my_var = getenv("MY_VAR");
    printf("MY_VAR=%s\n", my_var ? my_var : "<not set>");

    /* 5. Test putenv */
    putenv("PUT_VAR=from_putenv");
    const char *put_var = getenv("PUT_VAR");
    printf("PUT_VAR=%s\n", put_var ? put_var : "<not set>");

    /* 6. Test unsetenv */
    unsetenv("MY_VAR");
    my_var = getenv("MY_VAR");
    printf("MY_VAR=%s\n", my_var ? my_var : "<not set>");

    printf("DONE\n");
    return 0;
}
