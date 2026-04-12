/* POSIX.1-2024 clock-aware wait functions.
 * Delegate to the timed variants, ignoring the clock parameter
 * (all clocks are equivalent in Wasm — single monotonic time source). */

struct timespec;

/* Forward-declare the timed variants (defined in musl) */
int pthread_mutex_timedlock(void *restrict, const struct timespec *restrict);
int pthread_cond_timedwait(void *restrict, void *restrict, const struct timespec *restrict);
int pthread_rwlock_timedrdlock(void *restrict, const struct timespec *restrict);
int pthread_rwlock_timedwrlock(void *restrict, const struct timespec *restrict);

int pthread_mutex_clocklock(void *restrict m, int clock, const struct timespec *restrict at)
{
	return pthread_mutex_timedlock(m, at);
}

int pthread_cond_clockwait(void *restrict c, void *restrict m, int clock, const struct timespec *restrict at)
{
	return pthread_cond_timedwait(c, m, at);
}

int pthread_rwlock_clockrdlock(void *restrict rw, int clock, const struct timespec *restrict at)
{
	return pthread_rwlock_timedrdlock(rw, at);
}

int pthread_rwlock_clockwrlock(void *restrict rw, int clock, const struct timespec *restrict at)
{
	return pthread_rwlock_timedwrlock(rw, at);
}
