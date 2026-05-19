/* wasm32posix override: pshared signal routes to the kernel. */
#include "pthread_impl.h"

#define SYS_PSHARED_COND_SIGNAL 408

int pthread_cond_signal(pthread_cond_t *c)
{
	if (c->_c_shared) {
		long r = __syscall(SYS_PSHARED_COND_SIGNAL, c->__u.__i[1]);
		return r < 0 ? -r : 0;
	}
	return __private_cond_signal(c, 1);
}
