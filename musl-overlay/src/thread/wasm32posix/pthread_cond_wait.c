/* wasm32posix override: route pshared cond_wait to the kernel.
 * Non-pshared still uses musl's futex-based cond implementation. */
#include "pthread_impl.h"

/* Must match crates/kernel/src/wasm_api.rs. */
#define SYS_PSHARED_COND_WAIT_BEGIN 406
#define SYS_PSHARED_COND_WAIT_CHECK 407
#define SYS_PSHARED_COND_WAIT_ABORT 414

int pthread_cond_wait(pthread_cond_t *restrict c, pthread_mutex_t *restrict m)
{
	if (c->_c_shared) {
		/* Cond is pshared. Require the mutex be pshared too — the kernel
		 * only knows how to reacquire kernel-side mutexes on wake. */
		if (!(m->_m_type & 128)) return EINVAL;

		long r = __syscall(SYS_PSHARED_COND_WAIT_BEGIN,
		                    c->__u.__i[1], m->__u.__i[1]);
		if (r < 0) return -r;

		/* In centralized mode the kernel completes the syscall only when
		 * the waiter can proceed (signaled + mutex reacquired); EAGAIN is
		 * handled entirely by the host retry loop, so the loop below is
		 * defensive. */
		for (;;) {
			long rc = __syscall(SYS_PSHARED_COND_WAIT_CHECK,
			                     c->__u.__i[1], m->__u.__i[1]);
			if (rc >= 0) return 0;
			if (-rc != EAGAIN) {
				__syscall(SYS_PSHARED_COND_WAIT_ABORT, c->__u.__i[1]);
				return -rc;
			}
		}
	}
	return pthread_cond_timedwait(c, m, 0);
}
