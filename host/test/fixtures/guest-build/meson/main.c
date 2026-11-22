#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "config.h"
#include "ops.h"

#if !HAVE_UNISTD_H || !HAVE_GETOPT
#error "Meson's header and function probes found no getopt in <unistd.h>"
#endif

/* calc --version, or calc OP A B [EXPECTED]: print A OP B, and with
   EXPECTED exit 1 unless the result equals it. */
int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("calc %s (%s %s, long is %d bytes)\n",
               CALC_VERSION, CALC_SYSTEM, CALC_CPU_FAMILY, SIZEOF_LONG);
        return 0;
    }
    if (argc != 4 && argc != 5) {
        fprintf(stderr, "usage: calc OP A B [EXPECTED]\n");
        return 2;
    }
    long result = ops_apply(argv[1][0], strtol(argv[2], NULL, 10), strtol(argv[3], NULL, 10));
    printf("%ld\n", result);
    return argc == 5 && result != strtol(argv[4], NULL, 10);
}
