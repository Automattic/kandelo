/*
 * Deliberately trigger a Wasm integer divide-by-zero trap.
 */
#include <stdio.h>

int main(void)
{
    fprintf(stderr, "before-divzero\n");
    fflush(stderr);
    volatile int numerator = 1;
    volatile int denominator = 0;
    volatile int value = numerator / denominator;
    fprintf(stderr, "after-divzero-SHOULD-NEVER-REACH:%d\n", value);
    return 1;
}
