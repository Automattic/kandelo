/*
 * __clone.c -- Wasm64 arch-specific clone implementation.
 *
 * musl's pthread_create calls:
 *   __clone(fn, stack, flags, arg, ptid, tls, ctid)
 *
 * We call kernel_clone directly as a Wasm import, bypassing the
 * syscall dispatch since clone needs special handling (the fn/arg
 * must be passed to the host to invoke in the new thread).
 *
 * On wasm64 (LP64): pointers and uintptr_t are 64-bit.
 */

#include <stdint.h>

/* Kernel import — directly linked, not through syscall dispatch.
 * On wasm64, pointer-width params are i64 at the wasm level. */
__attribute__((import_module("kernel"), import_name("kernel_clone")))
extern int32_t kernel_clone(uintptr_t fn_ptr, uintptr_t stack_ptr,
                            uint32_t flags, uintptr_t arg,
                            uintptr_t ptid_ptr, uintptr_t tls_ptr,
                            uintptr_t ctid_ptr);

int __clone(int (*fn)(void *), void *stack, int flags, void *arg, ...)
{
    __builtin_va_list ap;
    __builtin_va_start(ap, arg);
    int *ptid = __builtin_va_arg(ap, int *);
    void *tls = __builtin_va_arg(ap, void *);
    int *ctid = __builtin_va_arg(ap, int *);
    __builtin_va_end(ap);

    return kernel_clone(
        (uintptr_t)fn,
        (uintptr_t)stack,
        (uint32_t)flags,
        (uintptr_t)arg,
        (uintptr_t)ptid,
        (uintptr_t)tls,
        (uintptr_t)ctid
    );
}
