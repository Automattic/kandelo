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
 *   8       48B   arguments (6 x i64)
 *   56      8B    return value (i64)
 *   64      4B    errno (i32)
 *   68      4B    reserved/pad
 *   72      64KB  data transfer buffer
 *
 * Each thread has its own channel region within the process's shared
 * WebAssembly.Memory. The base address is stored in __channel_base,
 * an imported WebAssembly global set by the host at instantiation time.
 *
 * This file replaces syscall_glue.c — no kernel.* Wasm imports are used.
 * User programs compiled with this glue have zero kernel imports.
 */

#include <stdint.h>
#include "abi_constants.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Exported ABI marker.
 *
 * Every user program built against this glue exports `__abi_version`,
 * which the host calls at instantiation time to verify the program
 * was built against a compatible kernel. The value comes from the
 * generated `abi_constants.h` header, which mirrors
 * wasm_posix_shared::ABI_VERSION — bump ABI_VERSION and regenerate
 * the header (`bash scripts/check-abi-version.sh update`) together.
 */
__attribute__((used))
__attribute__((retain))
__attribute__((export_name("__abi_version")))
unsigned int __wasm_posix_user_abi_version(void) {
    return WASM_POSIX_ABI_VERSION;
}

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
#define CH_ARG_SIZE 8
#define CH_RETURN   56
#define CH_ERRNO    64
#define CH_DATA     72
#define CH_DATA_SIZE 65536

/* Signal delivery area — last 48 bytes of data buffer */
#define CH_SIG_BASE     (CH_DATA + CH_DATA_SIZE - 48)
#define CH_SIG_SIGNUM   (CH_SIG_BASE)
#define CH_SIG_HANDLER  (CH_SIG_BASE + 4)
#define CH_SIG_FLAGS    (CH_SIG_BASE + 8)
#define CH_SIG_SI_VALUE (CH_SIG_BASE + 12)
#define CH_SIG_OLD_MASK (CH_SIG_BASE + 16)
#define CH_SIG_SI_CODE  (CH_SIG_BASE + 24)
#define CH_SIG_SI_PID   (CH_SIG_BASE + 28)
#define CH_SIG_SI_UID   (CH_SIG_BASE + 32)
#define CH_SIG_ALT_SP   (CH_SIG_BASE + 36)
#define CH_SIG_ALT_SIZE (CH_SIG_BASE + 40)

#define SA_SIGINFO 4
#define SYS_SIGPROCMASK 37
#define SYS_RT_SIGRETURN 208
#define SIG_SETMASK 2

/* Per-thread channel base address.
 *
 * Stored as an imported WebAssembly global — each wasm instance (thread)
 * gets its own copy, immune to cross-thread shared memory corruption.
 * The host provides the value via WebAssembly.Global at instantiation time.
 *
 * Unlike _Thread_local (which stores in shared linear memory at __tls_base +
 * offset), wasm globals are instance-local and cannot be corrupted by other
 * threads' pointer arithmetic into the same memory region. */
#if __SIZEOF_POINTER__ == 8
__asm__(".globaltype __channel_base, i64\n");
#else
__asm__(".globaltype __channel_base, i32\n");
#endif

static inline uintptr_t get_channel_base(void) {
    uintptr_t val;
    __asm__ volatile("global.get __channel_base\n"
                     "local.set %0" : "=r"(val));
    return val;
}

/* Return 0 to signal that channel base uses a wasm global import,
 * not a TLS memory address. The host checks: if this returns 0,
 * skip TLS-based channel setup (the global is set at instantiation). */
__attribute__((export_name("__get_channel_base_addr")))
uintptr_t __get_channel_base_addr(void) {
    return 0;
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
#define SYS_SPAWN 500  /* non-forking posix_spawn — see docs/plans/2026-05-04-non-forking-posix-spawn-design.md */

__attribute__((import_module("kernel"), import_name("kernel_fork")))
int32_t kernel_fork(void);

/* Direct fork/vfork/_Fork — call kernel_fork without going through the
 * general syscall dispatcher.  This ensures asyncify only instruments
 * fork callers, not every function that makes any syscall. */

void __fork_handler(int);

/* _Fork/fork/vfork MUST NOT be inlined. wasm-opt's asyncify pass matches
 * functions by name to instrument the call chain around kernel_fork (an
 * asyncify import). At -O2, LLVM inlines these wrappers into every caller
 * and can then eliminate the kernel_fork call on paths where it decides
 * the return value is unused in a specific way — a silent miscompile that
 * makes bash's make_child appear to "fork" but never actually invoke
 * kernel_fork, so pipeline child-side redirection runs in the parent
 * process and subsequent writes to the pipe fail with EPIPE. Keeping these
 * as distinct non-inlined functions preserves both the asyncify call graph
 * and the observable side effect of the kernel_fork import. */

__attribute__((noinline))
int _Fork(void)
{
    long ret = (long)kernel_fork();
    if (ret < 0) {
        *__errno_location() = (int)(-ret);
        return -1;
    }
    return (int)ret;
}

__attribute__((noinline))
int fork(void)
{
    __fork_handler(-1);
    int ret = _Fork();
    __fork_handler(!ret);
    return ret;
}

__attribute__((noinline))
int vfork(void)
{
    return fork();
}

/* ------------------------------------------------------------------ */
/* Signal delivery — invoked after each syscall if a signal is pending */
/* ------------------------------------------------------------------ */

/* Forward declaration */
static long __do_syscall(long n, long long a1, long long a2, long long a3,
                         long long a4, long long a5, long long a6);

static void __deliver_pending_signal(uintptr_t base)
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

    /* Read alt stack info — non-zero alt_sp means we need to switch
     * the wasm shadow stack (__stack_pointer) to the alt stack buffer
     * before calling the handler.  This makes &local_var land inside
     * the alt stack range, matching real sigaltstack behavior. */
    uint32_t alt_sp   = *(uint32_t *)(uintptr_t)(base + CH_SIG_ALT_SP);
    uint32_t alt_size = *(uint32_t *)(uintptr_t)(base + CH_SIG_ALT_SIZE);

    /* Clear signal delivery area before calling handler */
    *sig_signum_ptr = 0;

    /* Save the current shadow stack pointer and switch to alt stack
     * if the kernel told us to.  We use inline asm to access the wasm
     * __stack_pointer global directly.  The saved_sp local lives in a
     * wasm register (not on the shadow stack) so it survives the switch. */
    void *saved_sp = 0;
    if (alt_sp != 0) {
        __asm__ volatile("global.get __stack_pointer\nlocal.set %0" : "=r"(saved_sp));
        void *new_sp = (void *)(uintptr_t)(alt_sp + alt_size);
        /* Shadow stack grows downward — set to top of alt stack buffer */
        __asm__ volatile("local.get %0\nglobal.set __stack_pointer" :: "r"(new_sp));
    }

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

    /* Restore shadow stack before making further syscalls */
    if (saved_sp != 0) {
        __asm__ volatile("local.get %0\nglobal.set __stack_pointer" :: "r"(saved_sp));
    }

    /* Notify kernel that signal handler has returned.
     * This clears SS_ONSTACK if we were on the alt stack. */
    __do_syscall(SYS_RT_SIGRETURN, 0, 0, 0, 0, 0, 0);

    /* Restore the old blocked mask via sigprocmask syscall.
     * This also triggers delivery of any further pending signals
     * (the kernel writes signal info on the sigprocmask return). */
    __do_syscall(SYS_SIGPROCMASK, SIG_SETMASK,
                 (long)(uintptr_t)&old_mask, 0, 8, 0, 0);
}

/* ------------------------------------------------------------------ */
/* Central dispatch — writes to channel and blocks for result          */
/* ------------------------------------------------------------------ */

static long __do_syscall(long n, long long a1, long long a2, long long a3,
                         long long a4, long long a5, long long a6)
{
    /* Fork/vfork are handled by fork()/_Fork()/vfork() overrides above,
     * which call kernel_fork() directly.  If we somehow get here (e.g. a
     * program calls __syscall(SYS_fork) directly), return ENOSYS because
     * asyncify can't save the call stack through the channel path. */
    if (n == SYS_FORK || n == SYS_VFORK) {
        return -38; /* ENOSYS */
    }

    /* IMPORTANT: In multi-threaded wasm programs (like BEAM), all threads
     * share the same linear memory. The compiler may spill local variables
     * to the shadow stack (linear memory). If another thread's pointer
     * arithmetic overwrites the shadow stack, spilled values get corrupted.
     *
     * To avoid this, we use get_channel_base() (inline asm: global.get)
     * at each point where we need the channel base, rather than caching it
     * in a local variable that might be spilled to the shadow stack.
     * The wasm global is per-instance and immune to cross-thread corruption. */

    uintptr_t base = get_channel_base();

    /* Write syscall number and arguments directly using base offsets.
     * These are one-shot writes — if the shadow stack value of 'base' is
     * corrupted after these writes, it doesn't matter because we re-read
     * the global for the atomic operations below.
     * Args are written as i64 — on wasm32, long long values are sign-extended
     * from 32-bit long; on wasm64, they are native 64-bit. */
    *(int32_t *)(uintptr_t)(base + CH_SYSCALL) = (int32_t)n;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 0 * CH_ARG_SIZE) = (int64_t)a1;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 1 * CH_ARG_SIZE) = (int64_t)a2;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 2 * CH_ARG_SIZE) = (int64_t)a3;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 3 * CH_ARG_SIZE) = (int64_t)a4;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 4 * CH_ARG_SIZE) = (int64_t)a5;
    *(int64_t *)(uintptr_t)(base + CH_ARGS + 5 * CH_ARG_SIZE) = (int64_t)a6;

    /* Set status to PENDING and wake the kernel worker.
     * Use inline asm to read __channel_base directly from the wasm global,
     * bypassing any shadow stack spills that might be corrupted. */
    {
        uintptr_t addr;
        __asm__ volatile(
            "global.get __channel_base\n"
            "local.set %0"
            : "=r"(addr)
        );
        __c11_atomic_store((_Atomic int32_t *)(uintptr_t)(addr + CH_STATUS),
                           CH_PENDING, __ATOMIC_SEQ_CST);
        __builtin_wasm_memory_atomic_notify(
            (int32_t *)(uintptr_t)(addr + CH_STATUS), 1);
    }

    /* Block until the kernel sets status to COMPLETE or ERROR.
     * CRITICAL: Re-read __channel_base from the wasm global on every
     * iteration. The compiler at -O0 would spill the address to the
     * shadow stack, where cross-thread memory writes can corrupt it.
     * Reading from the global (a per-instance register) is immune. */
    {
        int wait_ret;
        do {
            uintptr_t addr;
            __asm__ volatile(
                "global.get __channel_base\n"
                "local.set %0"
                : "=r"(addr)
            );
            wait_ret = __builtin_wasm_memory_atomic_wait32(
                (int32_t *)(uintptr_t)(addr + CH_STATUS), CH_PENDING, -1);
        } while (wait_ret == 0);
    }

    /* Read result — re-read base from global for safety */
    base = get_channel_base();
    long result = (long)*(int64_t *)(uintptr_t)(base + CH_RETURN);
    int32_t err = *(int32_t *)(uintptr_t)(base + CH_ERRNO);

    /* Reset status to IDLE for next syscall */
    __c11_atomic_store((_Atomic int32_t *)(uintptr_t)(base + CH_STATUS),
                       CH_IDLE, __ATOMIC_SEQ_CST);

    /* Check for pending signal delivery from the kernel.
     * The kernel writes signal info to CH_SIG_* after each syscall if
     * a Handler signal is deliverable. We invoke the handler here,
     * synchronously before returning to the caller, matching POSIX
     * semantics (raise() doesn't return until signal handler completes). */
    __deliver_pending_signal(get_channel_base());

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

long __syscall1(long n, long long a1)
{
    return __do_syscall(n, a1, 0, 0, 0, 0, 0);
}

long __syscall2(long n, long long a1, long long a2)
{
    return __do_syscall(n, a1, a2, 0, 0, 0, 0);
}

long __syscall3(long n, long long a1, long long a2, long long a3)
{
    return __do_syscall(n, a1, a2, a3, 0, 0, 0);
}

long __syscall4(long n, long long a1, long long a2, long long a3, long long a4)
{
    return __do_syscall(n, a1, a2, a3, a4, 0, 0);
}

long __syscall5(long n, long long a1, long long a2, long long a3, long long a4, long long a5)
{
    return __do_syscall(n, a1, a2, a3, a4, a5, 0);
}

long __syscall6(long n, long long a1, long long a2, long long a3, long long a4, long long a5,
                long long a6)
{
    return __do_syscall(n, a1, a2, a3, a4, a5, a6);
}

/* Deferred cancellation.
 *
 * Stock musl dispatches cancellation-point syscalls through
 * __syscall_cp_asm, an arch-specific trampoline that the SIGCANCEL
 * handler can interrupt and re-direct to __cp_cancel.  Wasm has no
 * equivalent, so we implement deferred cancellation on the guest side:
 * musl-overlay/src/thread/wasm32posix/pthread_cancel.c provides
 * __testcancel (pthread_exit path) and __syscall_cp_check (the
 * one-function moral equivalent of stock __syscall_cp_asm +
 * __syscall_cp_c).  We invoke them here around the blocking dispatch.
 *
 * - Pre-dispatch:  __testcancel() — if cancellation is pending and
 *   enabled, pthread_exit(PTHREAD_CANCELED) before we block.
 * - Post-dispatch: __syscall_cp_check(r) — if cancellation arrived
 *   while we were blocked (host woke us with -EINTR on cancel), this
 *   either calls pthread_exit (ENABLE state) or synthesizes
 *   -ECANCELED (MASKED state, used inside pthread_cond_wait so it can
 *   reacquire the mutex and then trigger the actual exit).
 *
 * Non-cancel-point syscalls (the __syscall_N entries) deliberately
 * skip this — POSIX reserves cancellation for the specific
 * cancellation-point functions.  Only __syscall_cp threads it.
 *
 * Async cancellation of a pure-CPU loop is not supported: there is no
 * wasm facility to preempt a running thread mid-computation.
 */
extern void __testcancel(void);
extern long __syscall_cp_check(long r);

long __syscall_cp(long n, long a1, long a2, long a3, long a4, long a5,
                  long a6)
{
    __testcancel();
    long r = __do_syscall((long long)n, (long long)a1, (long long)a2,
                          (long long)a3, (long long)a4, (long long)a5,
                          (long long)a6);
    return __syscall_cp_check(r);
}

#ifdef __cplusplus
}
#endif

