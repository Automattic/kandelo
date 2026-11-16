/* PROTOTYPE (process-shared sync design): a process-shared semaphore's
 * value lives in the kernel, keyed by the identity of the memory object
 * that holds the sem_t. Private semaphores keep musl's futex path. */
#include <semaphore.h>
#include <limits.h>
#include <errno.h>
#include "syscall.h"

#define SYS_PSYNC_SEM 440
#define PSYNC_SEM_INIT 0

int sem_init(sem_t *sem, int pshared, unsigned value)
{
	if (value > SEM_VALUE_MAX) {
		errno = EINVAL;
		return -1;
	}
	sem->__val[0] = value;
	sem->__val[1] = 0;
	sem->__val[2] = pshared ? 0 : 128;
	if (pshared) {
		long r = __syscall(SYS_PSYNC_SEM, PSYNC_SEM_INIT, sem, (long)value, 0);
		if (r < 0) { errno = -r; return -1; }
	}
	return 0;
}
