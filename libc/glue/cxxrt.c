/* cxxrt.c — Minimal C++ runtime for wasm32.
 *
 * Provides the operator new/delete forms and __cxa_pure_virtual that
 * C++ code linked with wasm32posix-c++ can need without libc++abi.
 *
 * All symbols are weak so that libc++abi can override them when linked.
 * Programs that don't link libc++abi still get working new/delete from here.
 */

#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The minimal runtime covers only what a C++ program can need without
 * libc++abi: the eight operator new/delete forms and __cxa_pure_virtual.
 * Anything else (static-local guards, dynamic_cast, exceptions, thread_local
 * destructors) needs the real runtime: link -lc++abi (the libcxx package).
 * Before ABI 44 the host silently supplied JavaScript stand-ins for those;
 * now such a program fails to link instead.
 *
 * Without libc++abi there is no exception runtime to throw std::bad_alloc,
 * so the throwing forms abort on allocation failure rather than returning
 * NULL, which callers of throwing new never check.
 */
struct kandelo_nothrow_t;

static void *kandelo_new_or_abort(unsigned long size) {
    void *p = malloc(size ? size : 1);
    if (!p) abort();
    return p;
}

/* operator new(size_t) */
__attribute__((weak))
void *_Znwm(unsigned long size) { return kandelo_new_or_abort(size); }

/* operator new[](size_t) */
__attribute__((weak))
void *_Znam(unsigned long size) { return kandelo_new_or_abort(size); }

/* operator new(size_t, const std::nothrow_t&) */
__attribute__((weak))
void *_ZnwmRKSt9nothrow_t(unsigned long size, const struct kandelo_nothrow_t *tag) {
    (void)tag;
    return malloc(size ? size : 1);
}

/* operator new[](size_t, const std::nothrow_t&) */
__attribute__((weak))
void *_ZnamRKSt9nothrow_t(unsigned long size, const struct kandelo_nothrow_t *tag) {
    (void)tag;
    return malloc(size ? size : 1);
}

/* operator delete(void*) */
__attribute__((weak))
void _ZdlPv(void *ptr) { free(ptr); }

/* operator delete(void*, size_t) */
__attribute__((weak))
void _ZdlPvm(void *ptr, unsigned long size) {
    (void)size;
    free(ptr);
}

/* operator delete[](void*) */
__attribute__((weak))
void _ZdaPv(void *ptr) { free(ptr); }

/* operator delete[](void*, size_t) */
__attribute__((weak))
void _ZdaPvm(void *ptr, unsigned long size) {
    (void)size;
    free(ptr);
}

/* Called when a pure virtual function is invoked */
__attribute__((weak))
void __cxa_pure_virtual(void) {
    __builtin_trap();
}

#ifdef __cplusplus
}
#endif
