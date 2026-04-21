/* wasm32posix override: route kernel-managed pshared mutexes through the
 * kernel; everything else falls through to musl's normal private-mutex
 * logic (copied verbatim from musl/src/thread/pthread_mutex_lock.c).
 *
 * A non-zero value in __u.__i[1] means pthread_mutex_init allocated a
 * kernel-side mutex ID for this object. Robust+pshared mutexes are not
 * kernel-managed (see pthread_mutex_init.c for rationale) and fall
 * through to musl's futex path. */
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
	if ((m->_m_type & 128) && !(m->_m_type & 4)) {
		long r = __syscall(SYS_PSHARED_MUTEX_LOCK, m->__u.__i[1]);
		return r < 0 ? -r : 0;
	}
	return __pthread_mutex_lock(m);
}
