#include <semaphore.h>
#include <limits.h>
#include "pthread_impl.h"

static void cleanup(void *p)
{
	a_dec(p);
}

/* Keep musl's semaphore protocol and cancellation path shared by both
 * entry points. The absolute deadline belongs to the caller's clock. */
static int timedwait(sem_t *restrict sem, clockid_t clock, const struct timespec *restrict at)
{
	pthread_testcancel();

	if (!sem_trywait(sem)) return 0;

	int spins = 100;
	while (spins-- && !(sem->__val[0] & SEM_VALUE_MAX) && !sem->__val[1])
		a_spin();

	while (sem_trywait(sem)) {
		int r, priv = sem->__val[2];
		a_inc(sem->__val+1);
		a_cas(sem->__val, 0, 0x80000000);
		pthread_cleanup_push(cleanup, (void *)(sem->__val+1));
		r = __timedwait_cp(sem->__val, 0x80000000, clock, at, priv);
		pthread_cleanup_pop(1);
		if (r) {
			errno = r;
			return -1;
		}
	}
	return 0;
}

int sem_timedwait(sem_t *restrict sem, const struct timespec *restrict at)
{
	return timedwait(sem, CLOCK_REALTIME, at);
}

int sem_clockwait(sem_t *restrict sem, clockid_t clock, const struct timespec *restrict at)
{
	if (clock != CLOCK_REALTIME && clock != CLOCK_MONOTONIC) {
		errno = EINVAL;
		return -1;
	}
	return timedwait(sem, clock, at);
}
