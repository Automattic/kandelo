/*
 * __unmapself.c -- Wasm-specific thread self-unmapping.
 *
 * On real architectures, __unmapself switches to a temporary stack,
 * unmaps the thread's stack, then calls SYS_exit. On Wasm, we can't
 * switch stacks, but munmap only untracks the region (no real page
 * deallocation), so it's safe to call from the thread's own stack.
 */
#include "pthread_impl.h"
#include "syscall.h"

void __unmapself(void *base, size_t size)
{
    __syscall(SYS_munmap, base, size);
    __syscall(SYS_exit, 0);
    __builtin_unreachable();
}
