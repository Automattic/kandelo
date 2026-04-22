/* wasm32posix override for pthread cancellation.
 *
 * Stock musl implements cancellation with SIGCANCEL + a PC-rewrite asm
 * trampoline (__syscall_cp_asm / __cp_begin / __cp_end / __cp_cancel).
 * That approach requires the kernel to interrupt a blocked syscall with
 * a signal and redirect the instruction pointer.  Wasm has no equivalent
 * of either facility, so we implement *deferred* cancellation only.
 *
 * Design — we chose per-thread state option (c):
 *   Use stock musl's `pthread_t->cancel` field as the cancel-pending flag.
 *
 *   (a) a reserved slot in the channel buffer, or
 *   (b) a thread-local global in the guest.
 *
 *   pthread_t->cancel is already:
 *     - atomic (`a_store`/`a_cas`)
 *     - thread-local (pinned to TLS via __pthread_self())
 *     - writable from any thread since all threads share linear memory
 *   so adding another slot would be redundant bookkeeping, and neither
 *   (a) nor (b) buys us anything except duplicated state.  The ABI-level
 *   addition is therefore limited to a single wake-up syscall
 *   (SYS_thread_cancel), not a channel-layout change.
 *
 * Flow:
 *   1. pthread_cancel(t) atomically sets `t->cancel = 1` and invokes
 *      SYS_thread_cancel(t->tid).
 *   2. The host intercepts SYS_thread_cancel and, if the target's channel
 *      is in a pending cancel-point syscall, completes it with -ECANCELED
 *      so the target wakes from Atomics.wait.  If the target is not
 *      blocked, the call is a no-op — the next cancel point will observe
 *      the flag.
 *   3. glue/channel_syscall.c::__syscall_cp calls __testcancel() before
 *      and after the blocking dispatch.  __testcancel reads self->cancel
 *      and, if set (and cancellation is enabled), calls __cancel(), which
 *      in turn runs pthread_exit(PTHREAD_CANCELED) — unwinding cleanup
 *      handlers and TSD destructors before the thread terminates.
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

/* Must match crates/shared/src/lib.rs and host/src/kernel-worker.ts. */
#define SYS_thread_cancel 415

/* Replaces musl/src/thread/pthread_cancel.c::__cancel.
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

/* Check-for-cancel hook called by glue/channel_syscall.c::__syscall_cp
 * both *before* and *after* a cancellation-point syscall.  This is the
 * one-function moral equivalent of stock musl's __syscall_cp_asm +
 * __syscall_cp_c combo:
 *
 *   - If the thread has cancellation entirely disabled or no cancel is
 *     pending, return `r` unchanged (or 0 on the pre-call edge).
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
	pthread_t self = __pthread_self();
	if (!self->cancel) return r;
	if (self->canceldisable == PTHREAD_CANCEL_DISABLE) return r;
	if (self->canceldisable == PTHREAD_CANCEL_ENABLE || self->cancelasync)
		pthread_exit(PTHREAD_CANCELED);
	/* MASKED: synthesize -ECANCELED and block further cancellation. */
	self->canceldisable = PTHREAD_CANCEL_DISABLE;
	return -ECANCELED;
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
	 * __syscall_cp_check in glue/channel_syscall.c.
	 *
	 * If the target is not blocked the host treats this as a no-op and
	 * returns 0; the target will observe self->cancel on its next
	 * cancel-point entry. */
	if (t->tid > 0) {
		__syscall(SYS_thread_cancel, t->tid);
	}
	return 0;
}
