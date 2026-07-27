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
 *      __syscall_cp_check() after it. ENABLE exits immediately; MASKED
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

/* Strong definition — replaces the weak dummy that stock musl installs
 * in pthread_testcancel.c when pthread_cancel.c is not linked. */
void __testcancel(void)
{
	pthread_t self = __pthread_self();
	if (self->cancel && !self->canceldisable)
		__cancel();
}

/* Check-for-cancel hook called before a cancellation-point syscall. This is
 * the guest-side pre-registration half of the cancellation transport:
 *
 *   - ENABLE exits immediately.
 *   - DISABLE leaves the operation live.
 *   - MASKED returns -ECANCELED and switches to DISABLE so a condition wait
 *     can remove its waiter and reacquire its mutex before exiting.
 *
 * A host pending-cancel marker covers cross-thread cancellation that raced a
 * blocking registration. This preflight is still required for self-pending
 * MASKED cancellation, where pthread_cancel intentionally makes no host
 * syscall and therefore cannot install such a marker. */
hidden long __syscall_cp_cancel_preflight(void)
{
	pthread_t self = __pthread_self();
	if (!self->cancel) return 0;
	if (self->canceldisable == PTHREAD_CANCEL_DISABLE) return 0;
	if (self->canceldisable == PTHREAD_CANCEL_ENABLE || self->cancelasync)
		pthread_exit(PTHREAD_CANCELED);
	self->canceldisable = PTHREAD_CANCEL_DISABLE;
	return -ECANCELED;
}

/* Check-for-cancel hook called after a cancellation-point syscall. This is the
 * one-function moral equivalent of stock musl's __syscall_cp_asm +
 * __syscall_cp_c combo:
 *
 *   - If the syscall was not interrupted with EINTR, return `r` unchanged.
 *     In particular, do not discard a successful syscall after its externally
 *     visible side effects have already happened.
 *   - If the thread has cancellation entirely disabled or no cancel is
 *     pending, return `r` unchanged.
 *   - If `self->cancel` is set and the state is ENABLE (or async),
 *     terminate the thread via pthread_exit(PTHREAD_CANCELED) — same
 *     path as stock __testcancel.
 *   - If the state is MASKED, synthesize a -ECANCELED return the way
 *     stock __syscall_cp_asm would, and mark the thread DISABLE so
 *     pthread_cond_wait's `if (e == ECANCELED)` branch runs cleanly
 *     after it reacquires the mutex and re-enables cancellation.  This
 *     is the behavior pthread_cond_timedwait.c expects: it sets MASKED
 *     around __timedwait_cp, checks for ECANCELED afterwards, and
 *     re-calls __pthread_testcancel once cs is restored to trigger the
 *     actual pthread_exit.
 */
hidden long __syscall_cp_check(long r)
{
	if (r != -EINTR) return r;
	long cancel = __syscall_cp_cancel_preflight();
	return cancel ? cancel : r;
}

/* Freeze whether pthread_cancel may interrupt this exact request.
 *
 * MASKED is intentionally wakeable: pthread_cond_timedwait relies on the
 * EINTR -> ECANCELED handoff so it can reacquire the mutex before enabling
 * cancellation and exiting. DISABLE instead keeps the operation live. */
hidden int __syscall_cp_cancel_wake_allowed(void)
{
	pthread_t self = __pthread_self();
	return self->canceldisable != PTHREAD_CANCEL_DISABLE;
}

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
