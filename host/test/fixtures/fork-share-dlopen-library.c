#include "abi_constants.h"

extern int fork(void);

#define BYTES (3 << 16)

static int counter = 5;
static char buffer[BYTES];

int bump(int by) {
    counter += by;
    return counter;
}

void fill(char value) {
    for (int i = 0; i < BYTES; i++) buffer[i] = value;
}

int check(char value) {
    for (int i = 0; i < BYTES; i++) if (buffer[i] != value) return 0;
    return 1;
}

int side_fork(void) {
    volatile int preserved = 37;
    int pid = fork();
    if (preserved != 37) return -2;
    return pid;
}

__attribute__((export_name("__abi_version")))
unsigned __abi_version(void) { return WASM_POSIX_ABI_VERSION; }
