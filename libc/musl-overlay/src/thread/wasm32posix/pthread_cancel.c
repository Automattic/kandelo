/* wasm32posix override for pthread cancellation.
 *
 * Stock musl implements cancellation with SIGCANCEL + a PC-rewrite asm
 * trampoline (__syscall_cp_asm / __cp_begin / __cp_end / __cp_cancel).
 * That approach requires the kernel to interrupt a blocked syscall with
 * a signal and redirect the instruction pointer.  Wasm has no equivalent
 * of either facility, so we implement *deferred* cancellation only.
 *
 * Design:
 *   Use stock musl's `pthread_t->cancel` field as the authoritative
 *   cancel-pending flag.
 *
 *   pthread_t->cancel is already:
 *     - atomic (`a_store`/`a_cas`)
 *     - thread-local (pinned to TLS via __pthread_self())
 *     - writable from any thread since all threads share linear memory
 *   so a second pending flag would be redundant bookkeeping. The channel's
 *   generated one-shot request flags carry only transport authority: whether
 *   this request came through __syscall_cp, and whether the target's frozen
 *   cancellation state allows the host to wake that request.
 *
 * Flow:
 *   1. pthread_cancel(t) atomically sets `t->cancel = 1` and invokes
 *      SYS_thread_cancel(t->tid).
 *   2. The host intercepts SYS_thread_cancel. It interrupts an in-flight
 *      cancellation point with EINTR only when that exact request also
 *      advertised cancellation-wake authority. PTHREAD_CANCEL_DISABLE omits
 *      that authority, so the operation and any finite deadline remain live
 *      while cancellation stays pending.
 *   3. libc/glue/channel_syscall.c::__syscall_cp calls
 *      __syscall_cp_cancel_preflight() before the blocking dispatch and
 *      __syscall_cp_check() after it (both in syscall_cp.c). ENABLE exits immediately; MASKED
 *      returns ECANCELED so condition-wait code can relock first; DISABLE
 *      leaves the operation live. A syscall that already completed keeps
 *      its result and leaves cancellation pending for the next point.
 *
 * Async cancellation (PTHREAD_CANCEL_ASYNCHRONOUS) is explicitly not
 * supported: wasm cannot preempt a running thread mid-computation.
 * pthread_cancel still records the flag for an async target, and if the
 * target later enters a cancel-point syscall it will be cancelled there,
 * but async cancel of a pure-CPU loop cannot be fulfilled.
 */

#include <string.h>
#include "pthread_impl.h"
#include "syscall.h"
#include <bits/kandelo_thread_syscalls.h>

/* The checks that run around cancellation-point syscalls (preflight, post-
 * syscall check, __testcancel, wake authority) live in syscall_cp.c. This
 * file holds only what can *request* a cancellation (pthread_cancel) and
 * what *acts* on one (__cancel), so programs that never cancel a thread do
 * not link thread exit into every syscall. */

/* Replaces libc/musl/src/thread/pthread_cancel.c::__cancel.
 * If cancellation is enabled on this thread, terminate with
 * PTHREAD_CANCELED (which also runs the cleanup-handler stack and the
 * TSD destructor chain).  Otherwise record -ECANCELED so the caller's
 * retry loop, if any, can observe the state. */
hidden long __cancel(void)
{
	pthread_t self = __pthread_self();
	if (self->canceldisable == PTHREAD_CANCEL_ENABLE || self->cancelasync)
		pthread_exit(PTHREAD_CANCELED);
	self->canceldisable = PTHREAD_CANCEL_DISABLE;
	return -ECANCELED;
}

/* timer_create() also writes `cancel`; it reads this to make sure the
 * strong __cancel above is linked whenever it is. See syscall_cp.c. */
hidden const volatile unsigned char __pthread_cancel_writer_linked = 1;

int pthread_cancel(pthread_t t)
{
	/* Record the pending cancel.  Visible to the target thread on its
	 * next read of self->cancel. */
	a_store(&t->cancel, 1);

	/* Self-cancel shortcut: if this thread already allowed async cancel
	 * we're expected to terminate immediately rather than waiting for a
	 * syscall boundary.  Stock musl gates this on cancelasync; we match
	 * that behavior for same-thread callers who rely on it. */
	if (t == __pthread_self()) {
		if (t->canceldisable == PTHREAD_CANCEL_ENABLE && t->cancelasync)
			pthread_exit(PTHREAD_CANCELED);
		return 0;
	}

	/* Wake the target if it is currently blocked in a cancel-point
	 * syscall (Atomics.wait on the channel).  The host is responsible
	 * for completing any in-flight cancel-point syscall with -EINTR so
	 * the target drops out of the wait and runs the post-syscall
	 * __syscall_cp_check in libc/glue/channel_syscall.c.
	 *
	 * If the target is not blocked the host treats this as a no-op and
	 * returns 0; the target will observe self->cancel on its next
	 * cancel-point entry. */
	if (t->tid > 0) {
		__syscall(KANDELO_SYS_THREAD_CANCEL, t->tid);
	}
	return 0;
}
