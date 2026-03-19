/*
 * __clone.c -- Wasm arch-specific clone implementation.
 *
 * musl's pthread_create calls:
 *   __clone(fn, stack, flags, arg, ptid, tls, ctid)
 *
 * We call kernel_clone directly as a Wasm import, bypassing the
 * syscall dispatch since clone needs special handling (the fn/arg
 * must be passed to the host to invoke in the new thread).
 */

#include <stdint.h>

/* Kernel import — directly linked, not through syscall dispatch */
__attribute__((import_module("kernel"), import_name("kernel_clone")))
extern int32_t kernel_clone(uint32_t fn_ptr, uint32_t stack_ptr,
                            uint32_t flags, uint32_t arg,
                            uint32_t ptid_ptr, uint32_t tls_ptr,
                            uint32_t ctid_ptr);

int __clone(int (*fn)(void *), void *stack, int flags, void *arg, ...)
{
    __builtin_va_list ap;
    __builtin_va_start(ap, arg);
    int *ptid = __builtin_va_arg(ap, int *);
    void *tls = __builtin_va_arg(ap, void *);
    int *ctid = __builtin_va_arg(ap, int *);
    __builtin_va_end(ap);

    return kernel_clone(
        (uint32_t)(uintptr_t)fn,
        (uint32_t)(uintptr_t)stack,
        (uint32_t)flags,
        (uint32_t)(uintptr_t)arg,
        (uint32_t)(uintptr_t)ptid,
        (uint32_t)(uintptr_t)tls,
        (uint32_t)(uintptr_t)ctid
    );
}
