#include <string.h>
#include <unistd.h>

static void *volatile handler;

static void reset_color(void)
{
    (void)write(STDOUT_FILENO, "handler\n", 8);
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "unreachable") == 0)
        __builtin_trap();
    if (!isatty(STDOUT_FILENO))
        return 0;

    // Match the old toybox exit path. The volatile load keeps this an
    // indirect call even when the fixture is built with optimization.
    handler = reset_color;
    ((void (*)(int))handler)(0);
    return 1;
}
