/*
 * klogctl() through the `kandelo.klog.v1` program extension.
 *
 * Upstream musl issues SYS_syslog (304). Kandelo's frozen base program surface
 * does not declare that syscall, and declaring it would change the contract
 * digest every supported program carries, so the kernel answers 304 with
 * ENOSYS. A program that calls klogctl() links this import instead: the host
 * refuses to start it unless it can serve the kernel message ring, and a
 * program that never calls klogctl() imports nothing and keeps its base
 * identity. See docs/program-extensions.md.
 */
#include <sys/klog.h>
#include <errno.h>

__attribute__((import_module("kandelo.klog.v1"), import_name("__kandelo_klogctl_v1")))
int __kandelo_klogctl_v1(char *buffer, int capacity, int action);

int klogctl(int type, char *buf, int len)
{
	int result = __kandelo_klogctl_v1(buf, len, type);
	if (result < 0) {
		errno = -result;
		return -1;
	}
	return result;
}
