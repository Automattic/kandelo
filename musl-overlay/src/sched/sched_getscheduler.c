#include <sched.h>
#include <errno.h>
#include "syscall.h"

int sched_getscheduler(pid_t pid)
{
	return __syscall_ret(__syscall1(SYS_sched_getscheduler, pid));
}
