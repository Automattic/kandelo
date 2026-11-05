#define _GNU_SOURCE
#include <errno.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include "syscall.h"

/* musl enumerates interfaces over rtnetlink, which Kandelo does not provide.
 * The kernel owns the interface table and answers the classic interface
 * ioctls, so build the list from those instead: one entry per interface,
 * with its IPv4 address, netmask and (for a broadcast-capable link) its
 * broadcast address. An interface without an address keeps a null
 * ifa_addr, as getifaddrs allows. There are no AF_PACKET or IPv6 entries:
 * the kernel models neither on these interfaces. */

struct ifaddrs_storage {
	struct ifaddrs ifa;
	struct sockaddr_in addr, netmask, broadaddr;
	char name[IF_NAMESIZE];
};

void freeifaddrs(struct ifaddrs *ifp)
{
	while (ifp) {
		struct ifaddrs *next = ifp->ifa_next;
		free(ifp);
		ifp = next;
	}
}

static int query(int fd, unsigned long request, const char *name, struct sockaddr_in *out)
{
	struct ifreq req = {0};
	strncpy(req.ifr_name, name, IF_NAMESIZE - 1);
	if (ioctl(fd, request, &req) < 0) return -1;
	memcpy(out, &req.ifr_addr, sizeof(*out));
	return 0;
}

int getifaddrs(struct ifaddrs **ifap)
{
	struct ifconf ifc = {0};
	struct ifreq *list = 0;
	struct ifaddrs *head = 0, **tail = &head;
	size_t count = 0;
	int fd, saved;

	if ((fd = socket(AF_INET, SOCK_DGRAM|SOCK_CLOEXEC, 0)) < 0) return -1;
	if (ioctl(fd, SIOCGIFCONF, &ifc) < 0 || ifc.ifc_len < 0) goto fail;
	if (ifc.ifc_len) {
		if (!(list = malloc(ifc.ifc_len))) goto fail;
		ifc.ifc_req = list;
		if (ioctl(fd, SIOCGIFCONF, &ifc) < 0) goto fail;
		count = ifc.ifc_len / sizeof(*list);
	}

	for (size_t i = 0; i < count; i++) {
		struct ifaddrs_storage *node = calloc(1, sizeof(*node));
		struct ifreq flags = {0};
		if (!node) goto fail;
		*tail = &node->ifa;
		tail = &node->ifa.ifa_next;
		memcpy(node->name, list[i].ifr_name, IF_NAMESIZE - 1);
		node->ifa.ifa_name = node->name;

		memcpy(flags.ifr_name, node->name, IF_NAMESIZE);
		if (ioctl(fd, SIOCGIFFLAGS, &flags) < 0) goto fail;
		node->ifa.ifa_flags = (unsigned short)flags.ifr_flags;

		/* EADDRNOTAVAIL is an interface with no address; anything else
		 * is a real failure to report. */
		if (query(fd, SIOCGIFADDR, node->name, &node->addr) < 0) {
			if (errno != EADDRNOTAVAIL) goto fail;
			continue;
		}
		node->ifa.ifa_addr = (struct sockaddr *)&node->addr;
		if (query(fd, SIOCGIFNETMASK, node->name, &node->netmask) < 0) goto fail;
		node->ifa.ifa_netmask = (struct sockaddr *)&node->netmask;
		if (node->ifa.ifa_flags & IFF_BROADCAST) {
			if (query(fd, SIOCGIFBRDADDR, node->name, &node->broadaddr) < 0) goto fail;
			node->ifa.ifa_broadaddr = (struct sockaddr *)&node->broadaddr;
		}
	}

	__syscall(SYS_close, fd);
	free(list);
	*ifap = head;
	return 0;

fail:
	saved = errno;
	__syscall(SYS_close, fd);
	free(list);
	freeifaddrs(head);
	errno = saved;
	return -1;
}
