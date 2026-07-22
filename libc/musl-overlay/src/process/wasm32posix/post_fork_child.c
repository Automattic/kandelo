/*
 * Restore musl's single-threaded child state after Kandelo resumes a fork
 * continuation. The child keeps the calling thread's TLS, so its copied
 * pthread descriptor must be rebound to the task ID allocated by the kernel.
 */

#include "pthread_impl.h"
#include "syscall.h"

hidden void __wasm_posix_after_fork_child(void)
{
	pthread_t self = __pthread_self();

	self->tid = __syscall(SYS_set_tid_address, &__thread_list_lock);
	self->robust_list.off = 0;
	self->robust_list.pending = 0;
	self->next = self->prev = self;
	__thread_list_lock = 0;
	libc.threads_minus_1 = 0;
	if (libc.need_locks) libc.need_locks = -1;
}
