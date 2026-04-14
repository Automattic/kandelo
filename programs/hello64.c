/* hello64.c — Prints type sizes to verify LP64 on wasm64. */
#include <stdio.h>
#include <stdint.h>

int main(void) {
    printf("sizeof(int) = %zu\n", sizeof(int));
    printf("sizeof(long) = %zu\n", sizeof(long));
    printf("sizeof(void*) = %zu\n", sizeof(void *));
    printf("sizeof(size_t) = %zu\n", sizeof(size_t));
    printf("sizeof(intptr_t) = %zu\n", sizeof(intptr_t));
    return 0;
}
