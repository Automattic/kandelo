/*
 * syscall_arch.h — wasm64posix syscall ABI definitions.
 *
 * On wasm64 (LP64), long is 8 bytes — native 64-bit args. No widening
 * needed. The __syscallN functions use long params that map to i64
 * wasm types directly.
 */

/* No-op: 64-bit values pass through as a single long arg on LP64. */
#define __SYSCALL_LL_E(x) (x)
#define __SYSCALL_LL_O(x) (x)

/* On wasm64, long is already 8 bytes. __scc casts to long (native i64).
 * syscall_arg_t is long (8 bytes), matching va_arg expectations. */
#define __scc(X) ((long) (X))
typedef long syscall_arg_t;

/*
 * Declare the dispatch functions. On wasm64, long is 64-bit (i64).
 * These are implemented in glue/channel_syscall.c.
 */
long __syscall0(long);
long __syscall1(long, long);
long __syscall2(long, long, long);
long __syscall3(long, long, long, long);
long __syscall4(long, long, long, long, long);
long __syscall5(long, long, long, long, long, long);
long __syscall6(long, long, long, long, long, long, long);
