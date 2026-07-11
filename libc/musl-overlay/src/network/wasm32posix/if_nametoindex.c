#define _GNU_SOURCE
#include <net/if.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <string.h>
#include "syscall.h"

unsigned if_nametoindex(const char *name)
{
	struct ifreq ifr = {0};
	int fd, r;

	if ((fd = socket(AF_INET, SOCK_DGRAM|SOCK_CLOEXEC, 0)) < 0) return 0;
	strncpy(ifr.ifr_name, name, sizeof ifr.ifr_name - 1);
	r = ioctl(fd, SIOCGIFINDEX, &ifr);
	__syscall(SYS_close, fd);
	return r < 0 ? 0 : ifr.ifr_ifindex;
}
