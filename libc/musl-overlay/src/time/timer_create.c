#include <time.h>
#include <signal.h>
#include <setjmp.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <errno.h>
#include "pthread_impl.h"
#include "atomic.h"

/*
 * Kandelo's timer_create syscall wire is four fixed-width i32 fields on both
 * wasm32 and wasm64. Direct SIGEV_SIGNAL/SIGEV_THREAD_ID delivery currently
 * carries the sival_int representation. SIGEV_THREAD callback values do not
 * cross this wire: the helper copies the full union sigval locally.
 */
struct ksigevent {
	int32_t sigev_value;
	int32_t sigev_signo;
	int32_t sigev_notify;
	int32_t sigev_tid;
};

_Static_assert(sizeof(struct ksigevent) == 16,
	"kernel sigevent wire must remain four i32 fields");
_Static_assert(offsetof(struct ksigevent, sigev_value) == 0,
	"kernel sigevent value offset");
_Static_assert(offsetof(struct ksigevent, sigev_signo) == 4,
	"kernel sigevent signo offset");
_Static_assert(offsetof(struct ksigevent, sigev_notify) == 8,
	"kernel sigevent notify offset");
_Static_assert(offsetof(struct ksigevent, sigev_tid) == 12,
	"kernel sigevent tid offset");

struct start_args {
	pthread_barrier_t b;
	struct sigevent *sev;
};

static void dummy_0()
{
}

weak_alias(dummy_0, __pthread_tsd_run_dtors);

static void cleanup_fromsig(void *p)
{
	pthread_t self = __pthread_self();
	__pthread_tsd_run_dtors();
	self->cancel = 0;
	self->cancelbuf = 0;
	self->canceldisable = 0;
	self->cancelasync = 0;
	__reset_tls();
	longjmp(p, 1);
}

static void *start(void *arg)
{
	pthread_t self = __pthread_self();
	struct start_args *args = arg;
	jmp_buf jb;

	/*
	 * Copy callback state before releasing the creating thread. In particular,
	 * val remains the full native-width union sigval on wasm64.
	 */
	void (*notify)(union sigval) = args->sev->sigev_notify_function;
	union sigval val = args->sev->sigev_value;

	pthread_barrier_wait(&args->b);
	if (self->cancel)
		return 0;

	for (;;) {
		siginfo_t si;
		while (sigwaitinfo(SIGTIMER_SET, &si) < 0);
		if (si.si_code == SI_TIMER && !setjmp(jb)) {
			pthread_cleanup_push(cleanup_fromsig, jb);
			notify(val);
			pthread_cleanup_pop(1);
		}
		if (self->timer_id < 0)
			break;
	}

	__syscall(SYS_timer_delete, self->timer_id & INT_MAX);
	return 0;
}

int timer_create(
	clockid_t clk,
	struct sigevent *restrict evp,
	timer_t *restrict res)
{
	static volatile int init;
	pthread_t td;
	pthread_attr_t attr;
	int r;
	struct start_args args;
	struct ksigevent ksev, *ksevp = 0;
	int timerid;
	sigset_t set;

	switch (evp ? evp->sigev_notify : SIGEV_SIGNAL) {
	case SIGEV_NONE:
	case SIGEV_SIGNAL:
	case SIGEV_THREAD_ID:
		if (evp) {
			/*
			 * The kernel ABI currently carries sival_int. A direct
			 * SIGEV_SIGNAL/SIGEV_THREAD_ID sival_ptr wider than 32 bits
			 * remains unsupported and must stay documented as such.
			 */
			ksev.sigev_value = evp->sigev_value.sival_int;
			ksev.sigev_signo = evp->sigev_notify == SIGEV_NONE
				? 0
				: evp->sigev_signo;
			ksev.sigev_notify = evp->sigev_notify;
			ksev.sigev_tid = evp->sigev_notify == SIGEV_THREAD_ID
				? evp->sigev_notify_thread_id
				: 0;
			ksevp = &ksev;
		}
		if (syscall(SYS_timer_create, clk, ksevp, &timerid) < 0)
			return -1;
		*res = (void *)(intptr_t)timerid;
		return 0;

	case SIGEV_THREAD:
		if (!init) {
			struct sigaction sa = { .sa_handler = SIG_DFL };
			__libc_sigaction(SIGTIMER, &sa, 0);
			a_store(&init, 1);
		}

		if (evp->sigev_notify_attributes)
			attr = *evp->sigev_notify_attributes;
		else
			pthread_attr_init(&attr);
		pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

		pthread_barrier_init(&args.b, 0, 2);
		args.sev = evp;

		__block_app_sigs(&set);
		__syscall(
			SYS_rt_sigprocmask,
			SIG_BLOCK,
			SIGTIMER_SET,
			0,
			_NSIG / 8);
		r = pthread_create(&td, &attr, start, &args);
		__restore_sigs(&set);
		if (r) {
			errno = r;
			return -1;
		}

		/*
		 * The callback value stays in the helper's local `val`; the kernel
		 * notification only wakes the exact helper TID.
		 */
		ksev.sigev_value = 0;
		ksev.sigev_signo = SIGTIMER;
		ksev.sigev_notify = SIGEV_THREAD_ID;
		ksev.sigev_tid = td->tid;

		if (syscall(SYS_timer_create, clk, &ksev, &timerid) < 0) {
			timerid = -1;
			td->cancel = 1;
		}
		td->timer_id = timerid;
		pthread_barrier_wait(&args.b);

		if (timerid < 0)
			return -1;

		*res = (void *)(INTPTR_MIN | (uintptr_t)td >> 1);
		return 0;

	default:
		errno = EINVAL;
		return -1;
	}
}
