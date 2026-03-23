/*
 * channel_syscall.c — Channel-based syscall dispatch for centralized kernel.
 *
 * Instead of importing kernel_* functions, this glue writes the syscall
 * number and arguments to a shared-memory channel, notifies the kernel
 * worker, and blocks until the result is ready.
 *
 * The channel layout matches wasm_posix_shared::channel:
 *   Offset  Size  Field
 *   0       4B    status (IDLE=0, PENDING=1, COMPLETE=2, ERROR=3)
 *   4       4B    syscall number
 *   8       24B   arguments (6 x i32)
 *   32      4B    return value
 *   36      4B    errno
 *   40      64KB  data transfer buffer
 *
 * Each thread has its own channel region within the process's shared
 * WebAssembly.Memory. The base address is stored in __channel_base,
 * a _Thread_local variable set during TLS initialization.
 *
 * This file replaces syscall_glue.c — no kernel.* Wasm imports are used.
 * User programs compiled with this glue have zero kernel imports.
 */

#include <stdint.h>

/* musl's errno is a macro expanding to (*__errno_location()). We only
 * need to set it on error, so we reference the function directly to
 * avoid pulling in the full errno.h header during cross-compilation. */
int *__errno_location(void);
#define errno (*__errno_location())

/* Channel status values */
#define CH_IDLE     0
#define CH_PENDING  1
#define CH_COMPLETE 2
#define CH_ERROR    3

/* Channel layout offsets */
#define CH_STATUS   0
#define CH_SYSCALL  4
#define CH_ARGS     8
#define CH_RETURN   32
#define CH_ERRNO    36
#define CH_DATA     40

/* Per-thread channel base address, set during TLS init by the host */
_Thread_local uint32_t __channel_base;

/* Return the address of __channel_base for the current thread.
 * The host uses this to find where to write the channel offset in TLS,
 * since __channel_base may not be at TLS offset 0 if the program has
 * its own _Thread_local variables. */
__attribute__((export_name("__get_channel_base_addr")))
uint32_t __get_channel_base_addr(void) {
    return (uint32_t)(uintptr_t)&__channel_base;
}

/* SYS_EXIT needs special handling */
#define SYS_EXIT 34

/* ------------------------------------------------------------------ */
/* Central dispatch — writes to channel and blocks for result          */
/* ------------------------------------------------------------------ */

static long __do_syscall(long n, long a1, long a2, long a3,
                         long a4, long a5, long a6)
{
    uint32_t base = __channel_base;

    volatile int32_t *status = (volatile int32_t *)(uintptr_t)(base + CH_STATUS);
    int32_t *syscall_nr      = (int32_t *)(uintptr_t)(base + CH_SYSCALL);
    int32_t *args             = (int32_t *)(uintptr_t)(base + CH_ARGS);
    int32_t *ret_ptr          = (int32_t *)(uintptr_t)(base + CH_RETURN);
    int32_t *err_ptr          = (int32_t *)(uintptr_t)(base + CH_ERRNO);

    /* Write syscall number and arguments */
    *syscall_nr = (int32_t)n;
    args[0] = (int32_t)a1;
    args[1] = (int32_t)a2;
    args[2] = (int32_t)a3;
    args[3] = (int32_t)a4;
    args[4] = (int32_t)a5;
    args[5] = (int32_t)a6;

    /* Set status to PENDING and wake the kernel worker.
     * Use __c11_atomic_store for the atomic store, and the Wasm-specific
     * builtins for notify/wait (memory.atomic.notify, memory.atomic.wait32). */
    __c11_atomic_store((_Atomic int32_t *)status, CH_PENDING, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int32_t *)status, 1);

    /* Block until the kernel sets status to COMPLETE or ERROR.
     * memory.atomic.wait32 returns:
     *   0 = "ok" (woken by notify)
     *   1 = "not-equal" (value already changed)
     *   2 = "timed-out"
     * We loop until status is no longer PENDING. */
    while (__builtin_wasm_memory_atomic_wait32((int32_t *)status, CH_PENDING, -1) == 0) {
        /* Re-check: wait returns 0 on wake, but status might still be
         * PENDING if it was a spurious wakeup. The atomic_wait will
         * immediately return "not-equal" if status has changed. */
    }

    /* Read result */
    long result = (long)*ret_ptr;
    int32_t err = *err_ptr;

    /* Reset status to IDLE for next syscall */
    __c11_atomic_store((_Atomic int32_t *)status, CH_IDLE, __ATOMIC_SEQ_CST);

    /* Return in musl's expected format: negative errno on error.
     * musl's __syscall_ret() converts this to set errno and return -1. */
    if (err) {
        return -(long)err;
    }
    return result;
}

/* ================================================================== */
/* Public __syscallN entry points — musl calls these                   */
/* ================================================================== */

long __syscall0(long n)
{
    return __do_syscall(n, 0, 0, 0, 0, 0, 0);
}

long __syscall1(long n, long a1)
{
    return __do_syscall(n, a1, 0, 0, 0, 0, 0);
}

long __syscall2(long n, long a1, long a2)
{
    return __do_syscall(n, a1, a2, 0, 0, 0, 0);
}

long __syscall3(long n, long a1, long a2, long a3)
{
    return __do_syscall(n, a1, a2, a3, 0, 0, 0);
}

long __syscall4(long n, long a1, long a2, long a3, long a4)
{
    return __do_syscall(n, a1, a2, a3, a4, 0, 0);
}

long __syscall5(long n, long a1, long a2, long a3, long a4, long a5)
{
    return __do_syscall(n, a1, a2, a3, a4, a5, 0);
}

long __syscall6(long n, long a1, long a2, long a3, long a4, long a5,
                long a6)
{
    return __do_syscall(n, a1, a2, a3, a4, a5, a6);
}

/* syscall_cp (cancellation-point version) — same as regular syscall
 * since Wasm has no thread cancellation. */
long __syscall_cp(long n, long a1, long a2, long a3, long a4, long a5,
                  long a6)
{
    return __do_syscall(n, a1, a2, a3, a4, a5, a6);
}

