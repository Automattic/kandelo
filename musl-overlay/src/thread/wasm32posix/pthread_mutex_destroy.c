/* wasm32posix override: pshared path tears down the kernel mutex so its
 * kernel-side entry is reclaimed; non-pshared destroy is a no-op in musl. */
#include "pthread_impl.h"

/* Must match crates/kernel/src/wasm_api.rs. */
#define SYS_PSHARED_MUTEX_DESTROY 404

int pthread_mutex_destroy(pthread_mutex_t *mutex)
{
	if (mutex->_m_type & 128) {
		long r = __syscall(SYS_PSHARED_MUTEX_DESTROY, mutex->__u.__i[1]);
		return r < 0 ? -r : 0;
	}
	return 0;
}
