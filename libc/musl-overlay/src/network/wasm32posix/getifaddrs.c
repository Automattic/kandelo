#define _GNU_SOURCE
#include <errno.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include "syscall.h"

/* musl enumerates interfaces over rtnetlink, which Kandelo does not provide.
 * The kernel owns the interface table and answers the classic interface
 * ioctls for IPv4 addresses, flags, netmasks and broadcasts. IPv6 addresses
 * come from the kernel's /proc/net/if_inet6. An interface without an address
 * keeps a null ifa_addr. Hardware addresses use SIOCGIFHWADDR. */

struct ifaddrs_storage {
	struct ifaddrs ifa;
	union {
		struct sockaddr_in v4;
		struct sockaddr_in6 v6;
	} addr, netmask;
	struct sockaddr_in broadaddr;
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

static int query_flags(int fd, struct ifaddrs *ifa)
{
	struct ifreq req = {0};
	strncpy(req.ifr_name, ifa->ifa_name, IF_NAMESIZE - 1);
	if (ioctl(fd, SIOCGIFFLAGS, &req) < 0) return -1;
	ifa->ifa_flags = (unsigned short)req.ifr_flags;
	return 0;
}

static unsigned hex_digit(char c)
{
	return c <= '9' ? c - '0' : c - 'a' + 10;
}

static int append_ipv6(int fd, struct ifaddrs **tail)
{
	FILE *source = fopen("/proc/net/if_inet6", "re");
	char line[128];
	int saved;

	/* Older kernels have no IPv6 inventory. Keep enumerating IPv4 there. */
	if (!source) return errno == ENOENT ? 0 : -1;

	while (fgets(line, sizeof(line), source)) {
		char address[33], name[IF_NAMESIZE], extra;
		unsigned index, prefix;
		if (sscanf(line, "%32[0-9a-f] %8x %2x %*2x %*2x %15s %c",
		    address, &index, &prefix, name, &extra) != 4 ||
		    strlen(address) != 32 || !index || prefix > 128) {
			errno = EIO;
			goto fail;
		}

		struct ifaddrs_storage *node = calloc(1, sizeof(*node));
		if (!node) goto fail;
		*tail = &node->ifa;
		tail = &node->ifa.ifa_next;
		strcpy(node->name, name);
		node->ifa.ifa_name = node->name;
		if (query_flags(fd, &node->ifa) < 0) goto fail;

		struct sockaddr_in6 *addr = &node->addr.v6;
		struct sockaddr_in6 *netmask = &node->netmask.v6;
		addr->sin6_family = netmask->sin6_family = AF_INET6;
		for (unsigned i = 0; i < 16; i++)
			addr->sin6_addr.s6_addr[i] =
				(hex_digit(address[2*i]) << 4) | hex_digit(address[2*i+1]);
		if (IN6_IS_ADDR_LINKLOCAL(&addr->sin6_addr)) addr->sin6_scope_id = index;
		memset(netmask->sin6_addr.s6_addr, 0xff, prefix / 8);
		if (prefix % 8)
			netmask->sin6_addr.s6_addr[prefix / 8] = 0xff << (8 - prefix % 8);
		node->ifa.ifa_addr = (struct sockaddr *)addr;
		node->ifa.ifa_netmask = (struct sockaddr *)netmask;
	}
	if (!ferror(source)) return fclose(source);

fail:
	saved = errno;
	fclose(source);
	errno = saved;
	return -1;
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
		if (!node) goto fail;
		*tail = &node->ifa;
		tail = &node->ifa.ifa_next;
		memcpy(node->name, list[i].ifr_name, IF_NAMESIZE - 1);
		node->ifa.ifa_name = node->name;

		if (query_flags(fd, &node->ifa) < 0) goto fail;

		/* EADDRNOTAVAIL is an interface with no address; anything else
		 * is a real failure to report. */
		if (query(fd, SIOCGIFADDR, node->name, &node->addr.v4) < 0) {
			if (errno != EADDRNOTAVAIL) goto fail;
			continue;
		}
		node->ifa.ifa_addr = (struct sockaddr *)&node->addr.v4;
		if (query(fd, SIOCGIFNETMASK, node->name, &node->netmask.v4) < 0) goto fail;
		node->ifa.ifa_netmask = (struct sockaddr *)&node->netmask.v4;
		if (node->ifa.ifa_flags & IFF_BROADCAST) {
			if (query(fd, SIOCGIFBRDADDR, node->name, &node->broadaddr) < 0) goto fail;
			node->ifa.ifa_broadaddr = (struct sockaddr *)&node->broadaddr;
		}
	}
	if (append_ipv6(fd, tail) < 0) goto fail;

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
