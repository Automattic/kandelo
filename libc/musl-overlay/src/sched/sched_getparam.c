#include <sched.h>
#include <errno.h>
#include "syscall.h"

int sched_getparam(pid_t pid, struct sched_param *param)
{
	return __syscall_ret(__syscall2(SYS_sched_getparam, pid, (long)param));
}
