/* wasm32posix: read prioceiling value from bits 16-23 of __attr. */
#include "pthread_impl.h"

int pthread_mutexattr_getprioceiling(const pthread_mutexattr_t *restrict a, int *restrict ceiling)
{
	*ceiling = (a->__attr >> 8) & 0xFF;
	return 0;
}
