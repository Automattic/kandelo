#include <time.h>
#include <signal.h>
#include <errno.h>
#include <stdint.h>
#include "syscall.h"

struct ksigevent {
	int32_t sigev_value;
	int32_t sigev_signo;
	int32_t sigev_notify;
	int32_t sigev_tid;
};

int timer_create(clockid_t clk, struct sigevent *restrict evp, timer_t *restrict res)
{
	struct ksigevent ksev, *ksevp = 0;
	int timerid;

	switch (evp ? evp->sigev_notify : SIGEV_SIGNAL) {
	case SIGEV_NONE:
	case SIGEV_SIGNAL:
		if (evp) {
			/*
			 * Kandelo's timer syscall ABI has four fixed-width i32 fields on
			 * both wasm32 and wasm64. The kernel currently carries the
			 * sival_int representation; a wasm64 sival_ptr cannot be preserved
			 * until that ABI is extended.
			 */
			ksev.sigev_value = evp->sigev_value.sival_int;
			ksev.sigev_signo = evp->sigev_notify == SIGEV_NONE
				? 0
				: evp->sigev_signo;
			ksev.sigev_notify = evp->sigev_notify;
			ksev.sigev_tid = 0;
			ksevp = &ksev;
		}
		if (syscall(SYS_timer_create, clk, ksevp, &timerid) < 0)
			return -1;
		*res = (void *)(intptr_t)timerid;
		return 0;
	case SIGEV_THREAD:
	case SIGEV_THREAD_ID:
		/*
		 * Kandelo does not implement either callback threads or Linux's
		 * thread-targeted signal delivery. Fail at the libc boundary instead
		 * of building musl's helper-thread path or deferring rejection to the
		 * kernel.
		 */
		errno = ENOTSUP;
		return -1;
	default:
		errno = EINVAL;
		return -1;
	}
}
