typedef int (*vfork_fn)(void);

extern void _exit(int);

static int loader_probe = 73;

int side_probe(void) {
    return loader_probe;
}

int side_vfork(vfork_fn invoke_vfork) {
    volatile int preserved = 101;
    int pid = invoke_vfork();
    if (preserved != 101 || loader_probe != 73) _exit(94);
    return pid;
}

#include "abi_constants.h"

__attribute__((export_name("__abi_version")))
unsigned __abi_version(void) {
    return WASM_POSIX_ABI_VERSION;
}
