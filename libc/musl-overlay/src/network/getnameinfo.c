#include <netdb.h>
#include <limits.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <net/if.h>
#include <ctype.h>
#include "lookup.h"
#include "stdio_impl.h"

static char *itoa(char *p, unsigned x) {
	p += 3*sizeof(int);
	*--p = 0;
	do {
		*--p = '0' + x % 10;
		x /= 10;
	} while (x);
	return p;
}

static void reverse_hosts(char *buf, const unsigned char *a, unsigned scopeid, int family)
{
	char line[512], *p, *z;
	unsigned char _buf[1032], atmp[16];
	struct address iplit;
	FILE _f, *f = __fopen_rb_ca("/etc/hosts", &_f, _buf, sizeof _buf);
	if (!f) return;
	if (family == AF_INET) {
		memcpy(atmp+12, a, 4);
		memcpy(atmp, "\0\0\0\0\0\0\0\0\0\0\xff\xff", 12);
		a = atmp;
	}
	while (fgets(line, sizeof line, f)) {
		if ((p=strchr(line, '#'))) *p++='\n', *p=0;

		for (p=line; *p && !isspace(*p); p++);
		if (!*p) continue;
		*p++ = 0;
		if (__lookup_ipliteral(&iplit, line, AF_UNSPEC)<=0)
			continue;

		if (iplit.family == AF_INET) {
			memcpy(iplit.addr+12, iplit.addr, 4);
			memcpy(iplit.addr, "\0\0\0\0\0\0\0\0\0\0\xff\xff", 12);
			iplit.scopeid = 0;
		}

		if (memcmp(a, iplit.addr, 16) || iplit.scopeid != scopeid)
			continue;

		for (; *p && isspace(*p); p++);
		for (z=p; *z && !isspace(*z); z++);
		*z = 0;
		if (z-p < 256) {
			memcpy(buf, p, z-p+1);
			break;
		}
	}
	__fclose_ca(f);
}

static void reverse_services(char *buf, int port, int dgram)
{
	unsigned long svport;
	char line[128], *p, *z;
	unsigned char _buf[1032];
	FILE _f, *f = __fopen_rb_ca("/etc/services", &_f, _buf, sizeof _buf);
	if (!f) return;
	while (fgets(line, sizeof line, f)) {
		if ((p=strchr(line, '#'))) *p++='\n', *p=0;

		for (p=line; *p && !isspace(*p); p++);
		if (!*p) continue;
		*p++ = 0;
		svport = strtoul(p, &z, 10);

		if (svport != port || z==p) continue;
		if (dgram && strncmp(z, "/udp", 4)) continue;
		if (!dgram && strncmp(z, "/tcp", 4)) continue;
		if (p-line > 32) continue;

		memcpy(buf, line, p-line);
		break;
	}
	__fclose_ca(f);
}

int getnameinfo(const struct sockaddr *restrict sa, socklen_t sl,
	char *restrict node, socklen_t nodelen,
	char *restrict serv, socklen_t servlen,
	int flags)
{
	char buf[256], num[3*sizeof(int)+1];
	int af = sa->sa_family;
	unsigned char *a;
	unsigned scopeid;

	switch (af) {
	case AF_INET:
		a = (void *)&((struct sockaddr_in *)sa)->sin_addr;
		if (sl < sizeof(struct sockaddr_in)) return EAI_FAMILY;
		scopeid = 0;
		break;
	case AF_INET6:
		a = (void *)&((struct sockaddr_in6 *)sa)->sin6_addr;
		if (sl < sizeof(struct sockaddr_in6)) return EAI_FAMILY;
		scopeid = ((struct sockaddr_in6 *)sa)->sin6_scope_id;
		break;
	default:
		return EAI_FAMILY;
	}

	if (node && nodelen) {
		buf[0] = 0;
		if (!(flags & NI_NUMERICHOST)) {
			reverse_hosts(buf, a, scopeid, af);
		}
		/*
		 * Forward lookups in this port use the host resolver via SYS_getaddrinfo.
		 * There is no UDP DNS backend for reverse PTR lookups, so fall back
		 * numerically after /etc/hosts instead of blocking in __res_send().
		 */
		if (!*buf) {
			if (flags & NI_NAMEREQD) return EAI_NONAME;
			inet_ntop(af, a, buf, sizeof buf);
			if (scopeid) {
				char *p = 0, tmp[IF_NAMESIZE+1];
				if (!(flags & NI_NUMERICSCOPE) &&
				    (IN6_IS_ADDR_LINKLOCAL(a) ||
				     IN6_IS_ADDR_MC_LINKLOCAL(a)))
					p = if_indextoname(scopeid, tmp+1);
				if (!p)
					p = itoa(num, scopeid);
				*--p = '%';
				strcat(buf, p);
			}
		}
		if (strlen(buf) >= nodelen) return EAI_OVERFLOW;
		strcpy(node, buf);
	}

	if (serv && servlen) {
		char *p = buf;
		int port = ntohs(((struct sockaddr_in *)sa)->sin_port);
		buf[0] = 0;
		if (!(flags & NI_NUMERICSERV))
			reverse_services(buf, port, flags & NI_DGRAM);
		if (!*p)
			p = itoa(num, port);
		if (strlen(p) >= servlen)
			return EAI_OVERFLOW;
		strcpy(serv, p);
	}

	return 0;
}
