/*
 * Restore musl's single-threaded child state after Kandelo resumes a fork
 * continuation. The child keeps the calling thread's TLS, so its copied
 * pthread descriptor must be rebound to the task ID allocated by the kernel.
 */

#include "pthread_impl.h"
#include "syscall.h"
#include <stdint.h>

static uint64_t native_fork_epoch;

hidden uint64_t __wasm_posix_native_fork_epoch(void)
{
	return native_fork_epoch;
}

hidden void __wasm_posix_after_fork_child(void)
{
	pthread_t self = __pthread_self();

	/* WHY: resetting the copied thread list erases whether a peer could have
	 * been midway through native-library mutation. Keep a monotonic child-only
	 * epoch for D-59's inherited Wayland boundary, before clearing that state.
	 * Connections created later capture this epoch; nested single-thread forks
	 * must neither revive older graphs nor invalidate a fresh connection.
	 * This is libc metadata, not a change to fork21 serialized bytes. */
	if (libc.threads_minus_1) {
		if (native_fork_epoch == UINT64_MAX) __builtin_trap();
		native_fork_epoch++;
	}

	self->tid = __syscall(SYS_set_tid_address, &__thread_list_lock);
	self->robust_list.off = 0;
	self->robust_list.pending = 0;
	self->next = self->prev = self;
	__thread_list_lock = 0;
	libc.threads_minus_1 = 0;
	if (libc.need_locks) libc.need_locks = -1;
}
