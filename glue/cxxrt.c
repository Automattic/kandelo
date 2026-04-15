/* cxxrt.c — Minimal C++ runtime for wasm32.
 *
 * Provides operator new/delete and __cxa_pure_virtual needed by
 * C++ code linked with wasm32posix-c++. The sysroot libc++.a and
 * libc++abi.a are empty stubs, so these must be provided here.
 */

#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/* operator new(size_t) */
void *_Znwm(unsigned long size) {
    void *p = malloc(size ? size : 1);
    return p;
}

/* operator delete(void*, size_t) */
void _ZdlPvm(void *ptr, unsigned long size) {
    (void)size;
    free(ptr);
}

/* operator new[](size_t) */
void *_Znam(unsigned long size) {
    void *p = malloc(size ? size : 1);
    return p;
}

/* operator delete[](void*) */
void _ZdaPv(void *ptr) {
    free(ptr);
}

/* Called when a pure virtual function is invoked */
void __cxa_pure_virtual(void) {
    __builtin_trap();
}

#ifdef __cplusplus
}
#endif
