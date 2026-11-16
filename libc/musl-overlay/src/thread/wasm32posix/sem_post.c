/* PROTOTYPE: see sem_init.c. Body after the pshared branch is musl's. */
#include <semaphore.h>
#include <limits.h>
#include "pthread_impl.h"

#define SYS_PSYNC_SEM 440
#define PSYNC_SEM_POST 1

int sem_post(sem_t *sem)
{
	int val, new, waiters, priv = sem->__val[2];
	if (!priv) {
		long r = __syscall(SYS_PSYNC_SEM, PSYNC_SEM_POST, sem, 0, 0);
		if (r < 0) { errno = -r; return -1; }
		return 0;
	}
	do {
		val = sem->__val[0];
		waiters = sem->__val[1];
		if ((val & SEM_VALUE_MAX) == SEM_VALUE_MAX) {
			errno = EOVERFLOW;
			return -1;
		}
		new = val + 1;
		if (waiters <= 1)
			new &= ~0x80000000;
	} while (a_cas(sem->__val, val, new) != val);
	if (val<0) __wake(sem->__val, waiters>1 ? 1 : -1, priv);
	return 0;
}
