/* wasm32posix override: pshared destroy releases the kernel entry;
 * non-pshared is a no-op in musl. */
#include "pthread_impl.h"

#define SYS_PSHARED_COND_DESTROY 410

int pthread_cond_destroy(pthread_cond_t *c)
{
	if (c->_c_shared) {
		long r = __syscall(SYS_PSHARED_COND_DESTROY, c->__u.__i[1]);
		return r < 0 ? -r : 0;
	}
	return 0;
}
