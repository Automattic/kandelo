/*
 * syscall_arch.h — wasm32posix syscall ABI definitions.
 *
 * On this architecture, __syscallN functions are implemented in
 * glue/channel_syscall.c as real functions (not inline assembly).
 * They dispatch on the syscall number and write to the shared-memory
 * channel with i64 arguments.
 *
 * With i64 channel args, 64-bit values (like lseek offsets) fit in a
 * single argument — no splitting needed.
 */

/* No-op: 64-bit values pass through as a single long long arg. */
#define __SYSCALL_LL_E(x) (x)
#define __SYSCALL_LL_O(x) (x)

/* Override musl's default __scc to cast to long long instead of long.
 * Without this, 64-bit values (lseek offsets, mmap lengths) would be
 * truncated to 32-bit before reaching the __syscallN functions.
 *
 * syscall_arg_t MUST stay as long (4 bytes on wasm32) because musl's
 * C syscall() variadic function uses va_arg(ap, syscall_arg_t).
 * Callers of syscall(long, ...) push 4-byte args; if syscall_arg_t
 * were long long (8 bytes), va_arg would read garbage upper bits. */
#define __scc(X) ((long long) (X))
typedef long syscall_arg_t;

/*
 * Declare the dispatch functions. Args are long long to match the
 * i64 channel layout — on wasm32, long is 32-bit but long long is
 * 64-bit, matching the channel's i64 arg slots.
 * musl's src/internal/syscall.h will layer __scc()-wrapping macros
 * on top of these declarations.
 */
long __syscall0(long);
long __syscall1(long, long long);
long __syscall2(long, long long, long long);
long __syscall3(long, long long, long long, long long);
long __syscall4(long, long long, long long, long long, long long);
long __syscall5(long, long long, long long, long long, long long, long long);
long __syscall6(long, long long, long long, long long, long long, long long, long long);
