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
#define CH_DATA_SIZE 65536

/* Signal delivery area — last 32 bytes of data buffer */
#define CH_SIG_BASE     (CH_DATA + CH_DATA_SIZE - 48)
#define CH_SIG_SIGNUM   (CH_SIG_BASE)
#define CH_SIG_HANDLER  (CH_SIG_BASE + 4)
#define CH_SIG_FLAGS    (CH_SIG_BASE + 8)
#define CH_SIG_SI_VALUE (CH_SIG_BASE + 12)
#define CH_SIG_OLD_MASK (CH_SIG_BASE + 16)
#define CH_SIG_SI_CODE  (CH_SIG_BASE + 24)
#define CH_SIG_SI_PID   (CH_SIG_BASE + 28)
#define CH_SIG_SI_UID   (CH_SIG_BASE + 32)

#define SA_SIGINFO 4
#define SYS_SIGPROCMASK 37
#define SIG_SETMASK 2

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

/* SYS_FORK/VFORK — kernel_fork import provides asyncify-based fork.
 * wasm-opt --asyncify instruments around kernel.kernel_fork, enabling
 * the host to save/restore the call stack across fork — so the child
 * resumes from the fork point with all local variables intact.
 *
 * IMPORTANT: fork()/vfork()/_Fork() call kernel_fork() directly below,
 * NOT through __do_syscall(). This keeps asyncify instrumentation limited
 * to the fork call chain. If kernel_fork were reachable from __do_syscall,
 * asyncify would instrument every function that makes any syscall (~54K
 * functions in PHP-FPM), bloating frame sizes and overflowing V8's stack
 * in browser web workers. */
#define SYS_FORK  212
#define SYS_VFORK 213

__attribute__((import_module("kernel"), import_name("kernel_fork")))
int32_t kernel_fork(void);

/* Direct fork/vfork/_Fork — call kernel_fork without going through the
 * general syscall dispatcher.  This ensures asyncify only instruments
 * fork callers, not every function that makes any syscall. */
int fork(void)
{
    long ret = (long)kernel_fork();
    if (ret < 0) {
        *__errno_location() = (int)(-ret);
        return -1;
    }
    return (int)ret;
}

int _Fork(void)
{
    return fork();
}

int vfork(void)
{
    return fork();
}

/* ------------------------------------------------------------------ */
/* Signal delivery — invoked after each syscall if a signal is pending */
/* ------------------------------------------------------------------ */

/* Forward declaration */
static long __do_syscall(long n, long a1, long a2, long a3,
                         long a4, long a5, long a6);

static void __deliver_pending_signal(uint32_t base)
{
    uint32_t *sig_signum_ptr  = (uint32_t *)(uintptr_t)(base + CH_SIG_SIGNUM);
    uint32_t *sig_handler_ptr = (uint32_t *)(uintptr_t)(base + CH_SIG_HANDLER);
    uint32_t *sig_flags_ptr   = (uint32_t *)(uintptr_t)(base + CH_SIG_FLAGS);

    uint32_t signum  = *sig_signum_ptr;
    if (signum == 0) return;

    uint32_t handler = *sig_handler_ptr;
    uint32_t flags   = *sig_flags_ptr;

    /* Read saved old blocked mask (8 bytes at CH_SIG_OLD_MASK) */
    uint64_t old_mask;
    __builtin_memcpy(&old_mask, (void *)(uintptr_t)(base + CH_SIG_OLD_MASK), 8);

    /* Clear signal delivery area before calling handler */
    *sig_signum_ptr = 0;

    /* Invoke the signal handler via function pointer.
     * In Wasm, function pointers are table indices — casting the
     * handler_index to a function pointer and calling it uses
     * call_indirect, which looks up the indirect function table. */
    if (flags & SA_SIGINFO) {
        /* Build a minimal siginfo_t on the stack for SA_SIGINFO handlers */
        int32_t si_value_int = *(int32_t *)(uintptr_t)(base + CH_SIG_SI_VALUE);
        int32_t si_code  = *(int32_t *)(uintptr_t)(base + CH_SIG_SI_CODE);
        int32_t si_pid   = *(int32_t *)(uintptr_t)(base + CH_SIG_SI_PID);
        int32_t si_uid   = *(int32_t *)(uintptr_t)(base + CH_SIG_SI_UID);
        /* siginfo_t layout (128 bytes):
         *   [0]  si_signo, [4] si_errno, [8] si_code,
         *   [12] si_pid, [16] si_uid, [20] si_value.sival_int */
        char siginfo_buf[128];
        __builtin_memset(siginfo_buf, 0, sizeof(siginfo_buf));
        *(int *)(siginfo_buf + 0) = (int)signum;       /* si_signo */
        *(int *)(siginfo_buf + 8) = si_code;            /* si_code */
        *(int *)(siginfo_buf + 12) = si_pid;            /* si_pid */
        *(int *)(siginfo_buf + 16) = si_uid;            /* si_uid */
        *(int *)(siginfo_buf + 20) = si_value_int;      /* si_value.sival_int */
        void (*sa)(int, void *, void *) =
            (void (*)(int, void *, void *))(uintptr_t)handler;
        sa((int)signum, (void *)siginfo_buf, (void *)0);
    } else {
        void (*sa)(int) = (void (*)(int))(uintptr_t)handler;
        sa((int)signum);
    }

    /* Restore the old blocked mask via sigprocmask syscall.
     * This also triggers delivery of any further pending signals
     * (the kernel writes signal info on the sigprocmask return). */
    __do_syscall(SYS_SIGPROCMASK, SIG_SETMASK,
                 (long)(uintptr_t)&old_mask, 0, 8, 0, 0);
}

/* ------------------------------------------------------------------ */
/* Central dispatch — writes to channel and blocks for result          */
/* ------------------------------------------------------------------ */

static long __do_syscall(long n, long a1, long a2, long a3,
                         long a4, long a5, long a6)
{
    /* Fork/vfork are handled by fork()/_Fork()/vfork() overrides above,
     * which call kernel_fork() directly.  If we somehow get here (e.g. a
     * program calls __syscall(SYS_fork) directly), return ENOSYS because
     * asyncify can't save the call stack through the channel path. */
    if (n == SYS_FORK || n == SYS_VFORK) {
        return -38; /* ENOSYS */
    }

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

    /* Check for pending signal delivery from the kernel.
     * The kernel writes signal info to CH_SIG_* after each syscall if
     * a Handler signal is deliverable. We invoke the handler here,
     * synchronously before returning to the caller, matching POSIX
     * semantics (raise() doesn't return until signal handler completes). */
    __deliver_pending_signal(base);

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

