#define _GNU_SOURCE
#include <dlfcn.h>
#include <limits.h>
#include <unistd.h>
#include "lock.h"

/*
 * dladdr (POSIX.1-2024) for Kandelo.
 *
 * Kandelo has no shared-object address ranges the C library can see: a
 * dlopen'd side module shares the main program's memory and function table,
 * so every non-null address is reported against the main program and the
 * symbol fields stay unknown. Like the musl and glibc dynamic linkers,
 * dli_fname names the main program's file, which the kernel reports as
 * /proc/self/exe (the resolved path the process was executed from).
 * Programs that locate their own installation this way, such as LLVM's
 * getMainExecutable(), depend on it.
 *
 * The name is read once per program image: fork keeps the executable, and
 * exec starts a new image.
 */

static char exe_path[PATH_MAX];
static int exe_len = -1;
static volatile int lock[1];

int dladdr(const void *addr, Dl_info *info)
{
	if (!addr) return 0;
	LOCK(lock);
	if (exe_len < 0) {
		ssize_t n = readlink("/proc/self/exe", exe_path, sizeof exe_path - 1);
		if (n >= 0) {
			exe_path[n] = 0;
			exe_len = n;
		}
	}
	int known = exe_len >= 0;
	UNLOCK(lock);
	if (!known) return 0;
	info->dli_fname = exe_path;
	info->dli_fbase = 0;
	info->dli_sname = 0;
	info->dli_saddr = 0;
	return 1;
}
