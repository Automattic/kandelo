/* PROTOTYPE: see sem_init.c. */
#include <semaphore.h>
#include <limits.h>
#include <errno.h>
#include "syscall.h"

#define SYS_PSYNC_SEM 440
#define PSYNC_SEM_GETVALUE 4

int sem_getvalue(sem_t *restrict sem, int *restrict valp)
{
	if (!sem->__val[2]) {
		long r = __syscall(SYS_PSYNC_SEM, PSYNC_SEM_GETVALUE, sem, 0, 0);
		if (r < 0) { errno = -r; return -1; }
		*valp = (int)r;
		return 0;
	}
	int val = sem->__val[0];
	*valp = val & SEM_VALUE_MAX;
	return 0;
}
