/* PROTOTYPE: see sem_init.c. Body after the pshared branch is musl's. */
#include <semaphore.h>
#include <limits.h>
#include "pthread_impl.h"

#define SYS_PSYNC_SEM 440
#define PSYNC_SEM_TRYWAIT 2

int sem_trywait(sem_t *sem)
{
	int val;
	if (!sem->__val[2]) {
		long r = __syscall(SYS_PSYNC_SEM, PSYNC_SEM_TRYWAIT, sem, 0, 0);
		if (r < 0) { errno = -r; return -1; }
		return 0;
	}
	while ((val=sem->__val[0]) & SEM_VALUE_MAX) {
		if (a_cas(sem->__val, val, val-1)==val) return 0;
	}
	errno = EAGAIN;
	return -1;
}
