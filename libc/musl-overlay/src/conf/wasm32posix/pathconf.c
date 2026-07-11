#include <stdint.h>
#include <unistd.h>
#include "syscall.h"

long pathconf(const char *path, int name)
{
	int64_t value = -1;
	long rc = __syscall(SYS_pathconf, path, name, &value);
	if (rc < 0) return __syscall_ret(rc);
	return (long)value;
}
