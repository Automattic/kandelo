/* wasm32posix: store prioceiling in __u.__i[3] (unused for PRIO_PROTECT). */
#include "pthread_impl.h"

int pthread_mutex_setprioceiling(pthread_mutex_t *restrict m, int ceiling, int *restrict old)
{
	if (old) *old = m->__u.__i[3];
	m->__u.__i[3] = ceiling;
	return 0;
}
