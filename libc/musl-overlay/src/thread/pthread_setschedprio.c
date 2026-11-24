#include "pthread_impl.h"
#include "lock.h"

int pthread_setschedprio(pthread_t t, int prio)
{
	int r;
	sigset_t set;
	struct sched_param param = { .sched_priority = prio };
	__block_app_sigs(&set);
	LOCK(t->killlock);
	r = !t->tid ? ESRCH : -__syscall(SYS_sched_setparam, t->tid, &param);
	UNLOCK(t->killlock);
	__restore_sigs(&set);
	return r;
}
