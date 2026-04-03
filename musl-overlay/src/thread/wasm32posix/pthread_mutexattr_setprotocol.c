/* wasm32posix override: accept PTHREAD_PRIO_PROTECT (no-op since there is
 * no real priority scheduling, but allows the API to work). */
#include "pthread_impl.h"

int pthread_mutexattr_setprotocol(pthread_mutexattr_t *a, int protocol)
{
	switch (protocol) {
	case PTHREAD_PRIO_NONE:
		a->__attr &= ~(8|16);
		return 0;
	case PTHREAD_PRIO_INHERIT:
		a->__attr = (a->__attr & ~16) | 8;
		return 0;
	case PTHREAD_PRIO_PROTECT:
		/* Use bit 4 (16) for PRIO_PROTECT flag */
		a->__attr = (a->__attr & ~8) | 16;
		return 0;
	default:
		return EINVAL;
	}
}
