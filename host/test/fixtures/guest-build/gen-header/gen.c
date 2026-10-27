/* Runs during the build and writes a header describing the machine it runs on. */
#include <stdio.h>

int main(void) {
    printf("#define GEN_SIZEOF_LONG %d\n", (int)sizeof(long));
    printf("#define GEN_SIZEOF_POINTER %d\n", (int)sizeof(void *));
    return 0;
}
