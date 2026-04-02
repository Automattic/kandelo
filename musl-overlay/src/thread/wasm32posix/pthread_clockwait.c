#include <errno.h>

/* Stub implementations for POSIX.1-2024 clock-aware wait functions.
 * These exist to provide linkable symbols so programs can compile.
 * They return EINVAL since no clock is actually supported. */

typedef void *restrict_ptr;
struct timespec;
struct __pthread_mutex_s;
struct __pthread_cond_s;
struct __pthread_rwlock_s;

int pthread_mutex_clocklock(void *restrict m, int clock, const void *restrict at)
{
	return EINVAL;
}

int pthread_cond_clockwait(void *restrict c, void *restrict m, int clock, const void *restrict at)
{
	return EINVAL;
}

int pthread_rwlock_clockrdlock(void *restrict rw, int clock, const void *restrict at)
{
	return EINVAL;
}

int pthread_rwlock_clockwrlock(void *restrict rw, int clock, const void *restrict at)
{
	return EINVAL;
}
