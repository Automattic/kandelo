/* wasm32posix override: when PTHREAD_PROCESS_SHARED is set on the
 * condattr (musl encodes as the sign bit of __attr), allocate a kernel
 * cond ID.
 *
 * The cond ID is stored in __u.__i[1] (overlapping with the _c_head
 * pointer slot in the musl layout — unused on the pshared path since
 * wait/signal/broadcast are serviced entirely by the kernel).
 */
#include "pthread_impl.h"

/* Must match crates/kernel/src/wasm_api.rs. */
#define SYS_PSHARED_COND_INIT 405

int pthread_cond_init(pthread_cond_t *restrict c, const pthread_condattr_t *restrict a)
{
	*c = (pthread_cond_t){0};
	if (a) {
		c->_c_clock = a->__attr & 0x7fffffff;
		if (a->__attr >> 31) {
			/* PTHREAD_PROCESS_SHARED */
			c->_c_shared = (void *)-1;
			long id = __syscall(SYS_PSHARED_COND_INIT);
			if (id < 0) return -id;
			c->__u.__i[1] = (int)id;
		}
	}
	return 0;
}
