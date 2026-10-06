/* wasm32posix: the cancellation checks that run around cancellation-point
 * syscalls, separated from the code that acts on a cancellation.
 *
 * Every program links these checks: libc/glue/channel_syscall.c calls
 * __syscall_cp_cancel_preflight and __syscall_cp_check around each
 * cancellation-point syscall, and libc's condition and semaphore waits call
 * __testcancel. A thread's `cancel` flag can only become nonzero if something
 * writes it, and only two things do: pthread_cancel() and timer_create()
 * (for its SIGEV_THREAD helper). Both live with the acting code, __cancel, in
 * pthread_cancel.c.
 *
 * WHY the split: when the checks lived in pthread_cancel.c, every syscall
 * linked __cancel and therefore pthread_exit, so every function that makes a
 * syscall appeared able to reach thread exit, its cleanup handlers, TSD
 * destructors and (for the last thread) exit handlers. Fork instrumentation
 * follows exactly those call edges. Here the checks reach __cancel only
 * through a weak definition. A program that links neither pthread_cancel nor
 * timer_create gets the weak one, whose code is unreachable because nothing
 * can set `cancel`; a program that links either gets the strong __cancel
 * from pthread_cancel.c, as before. Behaviour is unchanged in both cases.
 */

#include "pthread_impl.h"
#include "atomic.h"

hidden long __cancel(void);

/* Unreachable: with no writer of `cancel` linked the flag stays zero, so the
 * checks below never call this. Crash rather than guess if that invariant is
 * ever broken. */
static long cancel_without_writer(void)
{
	a_crash();
	return 0;
}

weak_alias(cancel_without_writer, __cancel);

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
	return __cancel();
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
 *     terminate the thread via pthread_exit(PTHREAD_CANCELED) (in __cancel)
 *     — same path as stock __testcancel.
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
