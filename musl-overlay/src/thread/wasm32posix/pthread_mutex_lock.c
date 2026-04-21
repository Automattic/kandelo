/* wasm32posix override: add a PTHREAD_PROCESS_SHARED fast path that routes
 * to the kernel, then fall through to musl's normal private-mutex logic
 * (copied verbatim from musl/src/thread/pthread_mutex_lock.c). */
#include "pthread_impl.h"

/* Must match crates/kernel/src/wasm_api.rs. */
#define SYS_PSHARED_MUTEX_LOCK 401

int __pthread_mutex_lock(pthread_mutex_t *m)
{
	if ((m->_m_type&15) == PTHREAD_MUTEX_NORMAL
	    && !a_cas(&m->_m_lock, 0, EBUSY))
		return 0;

	return __pthread_mutex_timedlock(m, 0);
}

int pthread_mutex_lock(pthread_mutex_t *m)
{
	if (m->_m_type & 128) {
		long r = __syscall(SYS_PSHARED_MUTEX_LOCK, m->__u.__i[1]);
		return r < 0 ? -r : 0;
	}
	return __pthread_mutex_lock(m);
}
