#define _GNU_SOURCE
#include <net/if.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <stdlib.h>
#include <string.h>
#include "syscall.h"

struct if_nameindex *if_nameindex(void)
{
	struct ifconf ifc = {0};
	struct ifreq *req = 0;
	struct if_nameindex *idx = 0;
	size_t count = 0;
	int fd;

	if ((fd = socket(AF_INET, SOCK_DGRAM|SOCK_CLOEXEC, 0)) < 0) return 0;

	/* Query the host-visible interface list instead of embedding interface
	 * numbers in libc. The terminating zero entry comes from calloc. */
	if (ioctl(fd, SIOCGIFCONF, &ifc) < 0 || ifc.ifc_len < 0) goto fail;
	if (ifc.ifc_len) {
		req = malloc(ifc.ifc_len);
		if (!req) goto fail;
		ifc.ifc_req = req;
		if (ioctl(fd, SIOCGIFCONF, &ifc) < 0) goto fail;
		count = ifc.ifc_len / sizeof(*req);
	}

	idx = calloc(count + 1, sizeof(*idx));
	if (!idx) goto fail;

	for (size_t i = 0; i < count; i++) {
		if (ioctl(fd, SIOCGIFINDEX, &req[i]) < 0) goto fail;
		idx[i].if_index = req[i].ifr_ifindex;
		idx[i].if_name = strdup(req[i].ifr_name);
		if (!idx[i].if_name) goto fail;
	}
	__syscall(SYS_close, fd);
	free(req);
	return idx;

fail:
	__syscall(SYS_close, fd);
	for (size_t i = 0; i < count; i++) free(idx ? idx[i].if_name : 0);
	free(idx);
	free(req);
	return 0;
}
