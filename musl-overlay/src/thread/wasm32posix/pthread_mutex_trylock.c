/* wasm32posix override: pshared fast path in front of musl's native
 * trylock logic (copied verbatim from musl/src/thread/pthread_mutex_trylock.c). */
#include "pthread_impl.h"

/* Must match crates/kernel/src/wasm_api.rs. */
#define SYS_PSHARED_MUTEX_TRYLOCK 402

int __pthread_mutex_trylock_owner(pthread_mutex_t *m)
{
	int old, own;
	int type = m->_m_type;
	pthread_t self = __pthread_self();
	int tid = self->tid;

	old = m->_m_lock;
	own = old & 0x3fffffff;
	if (own == tid) {
		if ((type&8) && m->_m_count<0) {
			old &= 0x40000000;
			m->_m_count = 0;
			goto success;
		}
		if ((type&3) == PTHREAD_MUTEX_RECURSIVE) {
			if ((unsigned)m->_m_count >= INT_MAX) return EAGAIN;
			m->_m_count++;
			return 0;
		}
	}
	if (own == 0x3fffffff) return ENOTRECOVERABLE;
	if (own || (old && !(type & 4))) return EBUSY;

	if (type & 128) {
		if (!self->robust_list.off) {
			self->robust_list.off = (char*)&m->_m_lock-(char *)&m->_m_next;
			__syscall(SYS_set_robust_list, &self->robust_list, 3*sizeof(long));
		}
		if (m->_m_waiters) tid |= 0x80000000;
		self->robust_list.pending = &m->_m_next;
	}
	tid |= old & 0x40000000;

	if (a_cas(&m->_m_lock, old, tid) != old) {
		self->robust_list.pending = 0;
		if ((type&12)==12 && m->_m_waiters) return ENOTRECOVERABLE;
		return EBUSY;
	}

success:
	if ((type&8) && m->_m_waiters) {
		int priv = (type & 128) ^ 128;
		__syscall(SYS_futex, &m->_m_lock, FUTEX_UNLOCK_PI|priv);
		self->robust_list.pending = 0;
		return (type&4) ? ENOTRECOVERABLE : EBUSY;
	}

	volatile void *next = self->robust_list.head;
	m->_m_next = next;
	m->_m_prev = &self->robust_list.head;
	if (next != &self->robust_list.head) *(volatile void *volatile *)
		((char *)next - sizeof(void *)) = &m->_m_next;
	self->robust_list.head = &m->_m_next;
	self->robust_list.pending = 0;

	if (old) {
		m->_m_count = 0;
		return EOWNERDEAD;
	}

	return 0;
}

int __pthread_mutex_trylock(pthread_mutex_t *m)
{
	if ((m->_m_type&15) == PTHREAD_MUTEX_NORMAL)
		return a_cas(&m->_m_lock, 0, EBUSY) & EBUSY;
	return __pthread_mutex_trylock_owner(m);
}

int pthread_mutex_trylock(pthread_mutex_t *m)
{
	if ((m->_m_type & 128) && !(m->_m_type & 4)) {
		long r = __syscall(SYS_PSHARED_MUTEX_TRYLOCK, m->__u.__i[1]);
		return r < 0 ? -r : 0;
	}
	return __pthread_mutex_trylock(m);
}
