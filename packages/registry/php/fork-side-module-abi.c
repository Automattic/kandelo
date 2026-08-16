#include "abi_constants.h"

/*
 * Opcache is a dlopen side module, so it must not link the process syscall
 * glue or a second libc. Fork instrumentation nevertheless serializes its
 * continuation frames. Export the ABI epoch that gives those frames meaning,
 * matching the contract used by every fork-capable side-module fixture.
 */
__attribute__((used))
__attribute__((retain))
__attribute__((export_name("__abi_version")))
unsigned int __wasm_posix_user_abi_version(void) {
    return WASM_POSIX_ABI_VERSION;
}
