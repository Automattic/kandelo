/* wasm32posix override: pshared barrier_wait routes to the kernel. The
 * non-pshared path (and the trivial count==1 shortcut) is copied verbatim
 * from musl/src/thread/pthread_barrier_wait.c. */
#include "pthread_impl.h"
#include <limits.h>

/* Must match crates/kernel/src/wasm_api.rs. */
#define SYS_PSHARED_BARRIER_WAIT 412

struct instance
{
	volatile int count;
	volatile int last;
	volatile int waiters;
	volatile int finished;
};

int pthread_barrier_wait(pthread_barrier_t *b)
{
	int limit = b->_b_limit;
	struct instance *inst;

	/* Trivial case: count was set at 1 */
	if (!limit) return PTHREAD_BARRIER_SERIAL_THREAD;

	/* Process-shared barriers route to the kernel; each process has its
	 * own linear memory so futex-based waits won't synchronize. */
	if (limit < 0) {
		long r = __syscall(SYS_PSHARED_BARRIER_WAIT, b->__u.__i[4]);
		if (r == PTHREAD_BARRIER_SERIAL_THREAD) return PTHREAD_BARRIER_SERIAL_THREAD;
		if (r >= 0) return 0;
		return -r;
	}

	/* Otherwise we need a lock on the barrier object */
	while (a_swap(&b->_b_lock, 1))
		__wait(&b->_b_lock, &b->_b_waiters, 1, 1);
	inst = b->_b_inst;

	/* First thread to enter the barrier becomes the "instance owner" */
	if (!inst) {
		struct instance new_inst = { 0 };
		int spins = 200;
		b->_b_inst = inst = &new_inst;
		a_store(&b->_b_lock, 0);
		if (b->_b_waiters) __wake(&b->_b_lock, 1, 1);
		while (spins-- && !inst->finished)
			a_spin();
		a_inc(&inst->finished);
		while (inst->finished == 1)
			__syscall(SYS_futex,&inst->finished,FUTEX_WAIT|FUTEX_PRIVATE,1,0) != -ENOSYS
			|| __syscall(SYS_futex,&inst->finished,FUTEX_WAIT,1,0);
		return PTHREAD_BARRIER_SERIAL_THREAD;
	}

	/* Last thread to enter the barrier wakes all non-instance-owners */
	if (++inst->count == limit) {
		b->_b_inst = 0;
		a_store(&b->_b_lock, 0);
		if (b->_b_waiters) __wake(&b->_b_lock, 1, 1);
		a_store(&inst->last, 1);
		if (inst->waiters)
			__wake(&inst->last, -1, 1);
	} else {
		a_store(&b->_b_lock, 0);
		if (b->_b_waiters) __wake(&b->_b_lock, 1, 1);
		__wait(&inst->last, &inst->waiters, 0, 1);
	}

	/* Last thread to exit the barrier wakes the instance owner */
	if (a_fetch_add(&inst->count,-1)==1 && a_fetch_add(&inst->finished,1))
		__wake(&inst->finished, 1, 1);

	return 0;
}
