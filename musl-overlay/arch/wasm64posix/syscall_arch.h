/*
 * syscall_arch.h — wasm64posix syscall ABI definitions.
 *
 * On LP64, long is 8 bytes, so 64-bit values fit in a single arg.
 * The __SYSCALL_LL_E/O macros are identity on LP64 (no splitting needed).
 */

#define __SYSCALL_LL_E(x) (x)
#define __SYSCALL_LL_O(x) (x)

/*
 * Declare the dispatch functions.  musl's src/internal/syscall.h will
 * layer __scc()-wrapping macros on top of these declarations.
 */
long __syscall0(long);
long __syscall1(long, long);
long __syscall2(long, long, long);
long __syscall3(long, long, long, long);
long __syscall4(long, long, long, long, long);
long __syscall5(long, long, long, long, long, long);
long __syscall6(long, long, long, long, long, long, long);
