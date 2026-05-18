/* wasm32posix: store prioceiling value in bits 16-23 of __attr. */
#include "pthread_impl.h"

int pthread_mutexattr_setprioceiling(pthread_mutexattr_t *a, int ceiling)
{
	if (ceiling < 0 || ceiling > 255)
		return EINVAL;
	a->__attr = (a->__attr & 0xFFFF00FFu) | ((unsigned)ceiling << 8);
	return 0;
}
