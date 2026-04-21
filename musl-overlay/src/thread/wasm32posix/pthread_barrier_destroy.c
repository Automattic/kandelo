/* wasm32posix override: pshared destroy releases the kernel entry;
 * non-pshared is a no-op in musl. */
#include "pthread_impl.h"
#include <limits.h>

#define SYS_PSHARED_BARRIER_DESTROY 413

int pthread_barrier_destroy(pthread_barrier_t *b)
{
	if (b->_b_limit & INT_MIN) {
		long r = __syscall(SYS_PSHARED_BARRIER_DESTROY, b->__u.__i[4]);
		return r < 0 ? -r : 0;
	}
	return 0;
}
