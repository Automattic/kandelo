#include <spawn.h>
#include <sched.h>

int posix_spawnattr_getschedparam(const posix_spawnattr_t *restrict attr,
	struct sched_param *restrict schedparam)
{
	schedparam->sched_priority = attr->__prio;
	return 0;
}

int posix_spawnattr_setschedparam(posix_spawnattr_t *restrict attr,
	const struct sched_param *restrict schedparam)
{
	attr->__prio = schedparam->sched_priority;
	return 0;
}

int posix_spawnattr_getschedpolicy(const posix_spawnattr_t *restrict attr, int *restrict policy)
{
	*policy = attr->__pol;
	return 0;
}

int posix_spawnattr_setschedpolicy(posix_spawnattr_t *attr, int policy)
{
	attr->__pol = policy;
	return 0;
}
