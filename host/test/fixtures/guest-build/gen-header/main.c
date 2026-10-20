#include <stdio.h>

#include "generated.h"

int add(int a, int b);

int main(void) {
    printf("sizeof(long) at build: %d, pointer: %d, sum: %d\n",
           GEN_SIZEOF_LONG, GEN_SIZEOF_POINTER, add(2, 3));
    return 0;
}
