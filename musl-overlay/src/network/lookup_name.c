/*
 * lookup_name.c — Wasm-POSIX override of musl's __lookup_name().
 *
 * Replaces the original which tries UDP DNS via __res_msend_rc().
 * Instead, delegates hostname resolution to the host via syscall #140
 * (SYS_getaddrinfo), which the kernel forwards to the host's network
 * backend (Node.js dns.lookup or browser synthetic IP).
 *
 * Resolution pipeline:
 *   1. NULL/empty name → loopback or wildcard (AI_PASSIVE)
 *   2. Numeric IP literal → __lookup_ipliteral() (no syscall)
 *   3. Hostname → syscall(SYS_getaddrinfo, name, result_buf) → 4 bytes IPv4
 */

#include <sys/socket.h>
#include <netinet/in.h>
#include <netdb.h>
#include <string.h>
#include <errno.h>
#include "lookup.h"
#include "syscall.h"

int __lookup_name(struct address buf[static MAXADDRS], char canon[static 256],
                  const char *name, int family, int flags)
{
	*canon = 0;

	/* 1. NULL or empty name: return loopback or wildcard */
	if (!name || !*name) {
		if (family == AF_INET6) return EAI_FAMILY;
		buf[0].family = AF_INET;
		buf[0].scopeid = 0;
		memset(buf[0].addr, 0, 16);
		if (!(flags & AI_PASSIVE)) {
			/* loopback: 127.0.0.1 */
			buf[0].addr[0] = 127;
			buf[0].addr[3] = 1;
		}
		/* else: wildcard 0.0.0.0 (already zeroed) */
		buf[0].sortkey = 0;
		return 1;
	}

	/* 2. Numeric IP literal */
	int r = __lookup_ipliteral(buf, name, family);
	if (r) return r; /* 1 = success, positive EAI_* = error, 0 = not literal */

	/* 3. Hostname: delegate to host via syscall */
	if (family == AF_INET6) return EAI_FAMILY;

	unsigned char result[4];
	long ret = __syscall2(SYS_getaddrinfo, (long)name, (long)result);
	if (ret < 0) {
		/* Map kernel errno to EAI_* */
		long e = -ret;
		if (e == ENOENT) return EAI_NONAME;
		return EAI_FAIL;
	}
	if (ret < 4) return EAI_FAIL;

	buf[0].family = AF_INET;
	buf[0].scopeid = 0;
	memset(buf[0].addr, 0, 16);
	memcpy(buf[0].addr, result, 4);
	buf[0].sortkey = 0;

	/* Set canonical name to the input hostname */
	size_t namelen = strlen(name);
	if (namelen >= 256) namelen = 255;
	memcpy(canon, name, namelen);
	canon[namelen] = 0;

	return 1;
}
