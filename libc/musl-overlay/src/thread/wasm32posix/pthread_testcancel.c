/* wasm32posix override for pthread_testcancel.
 *
 * Stock musl (libc/musl/src/thread/pthread_testcancel.c) ships a weak dummy
 * alias `__testcancel → dummy` plus a wrapper `__pthread_testcancel()`
 * that calls `__testcancel()`.  The intent is that if pthread_cancel.c
 * is also linked it overrides the weak with a strong `__testcancel`.
 *
 * Here __testcancel is a strong definition in syscall_cp.c, which every
 * program links, so there is no weak/strong race to lose. syscall_cp.c in
 * turn reaches the acting __cancel through a weak definition that the strong
 * one in pthread_cancel.c replaces whenever pthread_cancel or timer_create is
 * linked.
 */

#include "pthread_impl.h"

void __testcancel(void);

void __pthread_testcancel(void)
{
	__testcancel();
}

weak_alias(__pthread_testcancel, pthread_testcancel);
