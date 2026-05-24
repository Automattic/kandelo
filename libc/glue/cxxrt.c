/* cxxrt.c — Minimal C++ runtime for wasm32.
 *
 * Provides operator new/delete and __cxa_pure_virtual needed by
 * C++ code linked with wasm32posix-c++.
 *
 * All symbols are weak so that libc++abi can override them when linked.
 * Programs that don't link libc++abi still get working new/delete from here.
 */

#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/* operator new(size_t) */
__attribute__((weak))
void *_Znwm(unsigned long size) {
    void *p = malloc(size ? size : 1);
    return p;
}

/* operator delete(void*, size_t) */
__attribute__((weak))
void _ZdlPvm(void *ptr, unsigned long size) {
    (void)size;
    free(ptr);
}

/* operator new[](size_t) */
__attribute__((weak))
void *_Znam(unsigned long size) {
    void *p = malloc(size ? size : 1);
    return p;
}

/* operator delete[](void*) */
__attribute__((weak))
void _ZdaPv(void *ptr) {
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
