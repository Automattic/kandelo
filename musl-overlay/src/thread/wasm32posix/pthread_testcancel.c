/* wasm32posix override for pthread_testcancel.
 *
 * Stock musl (musl/src/thread/pthread_testcancel.c) ships a weak dummy
 * alias `__testcancel → dummy` plus a wrapper `__pthread_testcancel()`
 * that calls `__testcancel()`.  The intent is that if pthread_cancel.c
 * is also linked it overrides the weak with a strong `__testcancel`.
 *
 * With wasm-ld + archive semantics that override is fragile: if the weak
 * version's object file is pulled from the archive first to satisfy the
 * channel-syscall reference to `__testcancel`, the later strong
 * definition in pthread_cancel.o never gets linked in.  We hit exactly
 * that on our builds — __testcancel ran the empty dummy and cancellation
 * was silently ignored.
 *
 * Fix: remove the weak alias here and route `__pthread_testcancel` at
 * our strong `__testcancel` in pthread_cancel.c.  The overlay shadows
 * the stock file, so pthread_cancel.o is the only definition in libc.a.
 */

#include "pthread_impl.h"

void __testcancel(void);

void __pthread_testcancel(void)
{
	__testcancel();
}

weak_alias(__pthread_testcancel, pthread_testcancel);
