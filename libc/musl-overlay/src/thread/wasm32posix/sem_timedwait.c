/* PROTOTYPE: see sem_init.c. Body after the pshared branch is musl's. */
#include <semaphore.h>
#include <limits.h>
#include "pthread_impl.h"

#define SYS_PSYNC_SEM 440
#define PSYNC_SEM_TIMEDWAIT 3

static void cleanup(void *p)
{
	a_dec(p);
}

int sem_timedwait(sem_t *restrict sem, const struct timespec *restrict at)
{
	pthread_testcancel();

	if (!sem->__val[2]) {
		if (at && (unsigned long)at->tv_nsec >= 1000000000UL) {
			errno = EINVAL;
			return -1;
		}
		long r = __syscall_cp(SYS_PSYNC_SEM, PSYNC_SEM_TIMEDWAIT, sem,
			(long)at, CLOCK_REALTIME);
		if (r < 0) { errno = -r; return -1; }
		return 0;
	}

	if (!sem_trywait(sem)) return 0;

	int spins = 100;
	while (spins-- && !(sem->__val[0] & SEM_VALUE_MAX) && !sem->__val[1])
		a_spin();

	while (sem_trywait(sem)) {
		int r, priv = sem->__val[2];
		a_inc(sem->__val+1);
		a_cas(sem->__val, 0, 0x80000000);
		pthread_cleanup_push(cleanup, (void *)(sem->__val+1));
		r = __timedwait_cp(sem->__val, 0x80000000, CLOCK_REALTIME, at, priv);
		pthread_cleanup_pop(1);
		if (r) {
			errno = r;
			return -1;
		}
	}
	return 0;
}
