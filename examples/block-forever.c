/*
 * block-forever.c — parks in a blocking syscall indefinitely.
 *
 * Test fixture for the host teardown-reclamation path
 * ([JSC-TERMINATE-ATOMICS-WAIT-LEAK], see
 * docs/jsc-terminate-atomics-wait-workaround.md). The process sits in a
 * blocking nanosleep — i.e. Atomics.wait on its syscall channel — modeling an
 * idle daemon (nginx in accept(), php-fpm in epoll, a shell in read()). On
 * kernel destroy the host must wake it (complete the syscall with EINTR +
 * queue SIGKILL) so the guest glue runs kernel_exit and the worker becomes
 * reclaimable, instead of being force-terminated while parked in Atomics.wait.
 *
 * It never exits on its own, so a cooperative teardown exit is observable as
 * an exit status of 137 (128 + SIGKILL). host/test/teardown-reclaim.test.ts
 * asserts exactly that, on both V8 (Node) and JSC (Bun).
 */
#include <unistd.h>

int main(void) {
	for (;;) {
		sleep(1000000);
	}
	return 0;
}
