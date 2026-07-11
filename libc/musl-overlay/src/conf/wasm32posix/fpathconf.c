#include <stdint.h>
#include <unistd.h>
#include "syscall.h"

long fpathconf(int fd, int name)
{
	int64_t value = -1;
	long rc = __syscall(SYS_fpathconf, fd, name, &value);
	if (rc < 0) return __syscall_ret(rc);
	return (long)value;
}
