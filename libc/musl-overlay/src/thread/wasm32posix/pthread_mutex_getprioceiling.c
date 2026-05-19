/* wasm32posix: read prioceiling from __u.__i[3] (unused for PRIO_PROTECT). */
#include "pthread_impl.h"

int pthread_mutex_getprioceiling(const pthread_mutex_t *restrict m, int *restrict ceiling)
{
	*ceiling = m->__u.__i[3];
	return 0;
}
