/* wasm32posix override: also propagate prioceiling from attr to mutex. */
#include "pthread_impl.h"

int pthread_mutex_init(pthread_mutex_t *restrict m, const pthread_mutexattr_t *restrict a)
{
	*m = (pthread_mutex_t){0};
	if (a) {
		m->_m_type = a->__attr;
		/* Copy prioceiling (bits 8-15 of __attr) to __u.__i[3] */
		m->__u.__i[3] = (a->__attr >> 8) & 0xFF;
	}
	return 0;
}
