/* wasm32posix override: when PTHREAD_PROCESS_SHARED is set on a barrier
 * attribute (musl encodes as the sign bit of __attr), allocate a kernel
 * barrier ID and store it in __u.__i[4] (the _b_waiters2 slot).
 */
#include "pthread_impl.h"
#include <limits.h>

/* Must match crates/kernel/src/wasm_api.rs. */
#define SYS_PSHARED_BARRIER_INIT 411

int pthread_barrier_init(pthread_barrier_t *restrict b, const pthread_barrierattr_t *restrict a, unsigned count)
{
	if (count - 1 > INT_MAX - 1) return EINVAL;
	*b = (pthread_barrier_t){ ._b_limit = (count - 1) | (a ? a->__attr : 0) };
	if (a && (a->__attr & INT_MIN)) {
		long id = __syscall(SYS_PSHARED_BARRIER_INIT, count);
		if (id < 0) return -id;
		b->__u.__i[4] = (int)id;
	}
	return 0;
}
