/*
 * Deliberately dereference an address outside the configured wasm32
 * linear-memory maximum so the engine raises a memory OOB trap.
 */
#include <stdint.h>
#include <stdio.h>

int main(void)
{
    fprintf(stderr, "before-oob\n");
    fflush(stderr);
    volatile uint32_t *p = (volatile uint32_t *)(uintptr_t)0x7fffffffU;
    volatile uint32_t value = *p;
    fprintf(stderr, "after-oob-SHOULD-NEVER-REACH:%u\n", value);
    return 1;
}
