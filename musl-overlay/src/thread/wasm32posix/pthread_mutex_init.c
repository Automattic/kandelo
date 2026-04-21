/* wasm32posix override: propagate type + prioceiling, and — when the
 * PTHREAD_PROCESS_SHARED bit (musl encodes it as bit 7 of _m_type) is set
 * in the mutex attribute — allocate a kernel-side shared mutex and store
 * its ID in the struct where subsequent lock/unlock calls can find it.
 *
 * Wasm has no genuinely shared linear memory across processes (MAP_SHARED
 * returns an initially-identical COW page). For PSHARED primitives we keep
 * the authoritative state in the kernel; the struct embedded in the COW
 * page carries only an ID that both parent and child can read after fork.
 *
 * ID storage: __u.__i[1] (the _m_lock slot). Unused on the PSHARED path
 * since lock/unlock are serviced by the kernel.
 */
#include "pthread_impl.h"

/* Must match crates/kernel/src/wasm_api.rs. */
#define SYS_PSHARED_MUTEX_INIT 400

int pthread_mutex_init(pthread_mutex_t *restrict m, const pthread_mutexattr_t *restrict a)
{
	*m = (pthread_mutex_t){0};
	if (a) {
		m->_m_type = a->__attr;
		/* Copy prioceiling (bits 8-15 of __attr) to __u.__i[3] */
		m->__u.__i[3] = (a->__attr >> 8) & 0xFF;
		if (a->__attr & 128U) {
			/* PTHREAD_PROCESS_SHARED — allocate a kernel mutex.
			 * Pass the low 4 bits (mutex type) to the kernel so it
			 * can honor RECURSIVE / ERRORCHECK semantics. */
			long id = __syscall(SYS_PSHARED_MUTEX_INIT, a->__attr & 0xF);
			if (id < 0) return -id;
			m->__u.__i[1] = (int)id;
		}
	}
	return 0;
}
