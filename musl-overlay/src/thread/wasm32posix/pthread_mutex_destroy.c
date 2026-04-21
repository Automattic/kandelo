/* wasm32posix override: kernel-managed pshared mutexes (non-zero __i[1])
 * tear down the kernel entry. Otherwise replicate musl's native destroy,
 * which calls __vm_wait() for pshared nontrivial-type mutexes (robust,
 * errorcheck) so any pending robust_list slot can quiesce before the
 * memory goes away. */
#include "pthread_impl.h"

/* Must match crates/kernel/src/wasm_api.rs. */
#define SYS_PSHARED_MUTEX_DESTROY 404

int pthread_mutex_destroy(pthread_mutex_t *m)
{
	/* Kernel-managed: pshared without robust (see pthread_mutex_init.c).
	 * Using _m_type bits here, not __i[1], because __i[1] overlaps with
	 * _m_lock and has non-zero values for any locked non-pshared mutex. */
	if ((m->_m_type & 128) && !(m->_m_type & 4)) {
		long r = __syscall(SYS_PSHARED_MUTEX_DESTROY, m->__u.__i[1]);
		return r < 0 ? -r : 0;
	}
	if (m->_m_type > 128) __vm_wait();
	return 0;
}
