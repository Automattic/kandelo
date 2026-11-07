/* Typed syscall completion for runtimes with a 64-bit integer model. */
#ifndef _KANDELO_SYSCALL_H
#define _KANDELO_SYSCALL_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct kandelo_syscall_result {
    int64_t value;
    int32_t error;
};

/* Use libc's normal transport, signal delivery, and restart/deadline rules.
 * Keep the kernel's result and errno separate: a valid negative result
 * (for example F_GETOWN) is not an errno, and wasm32 long truncates int64_t. */
void __wasm_posix_syscall6(int32_t number, const int64_t arguments[6],
                         struct kandelo_syscall_result *result);

#ifdef __cplusplus
}
#endif

#endif
