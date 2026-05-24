/* inet_ntop - convert binary address to presentation format
 *
 * Fixed version: uses field-level analysis for IPv6 :: compression
 * instead of musl's character-level strspn which miscounts leading
 * zero sequences (a known musl bug per RFC 5952 Section 4.2.3).
 */

#include <sys/socket.h>
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

const char *inet_ntop(int af, const void *restrict a0, char *restrict s, socklen_t l)
{
	const unsigned char *a = a0;

	switch (af) {
	case AF_INET:
		if (snprintf(s, l, "%d.%d.%d.%d", a[0],a[1],a[2],a[3]) < l)
			return s;
		break;
	case AF_INET6: {
		/* Parse into 8 16-bit fields */
		unsigned fields[8];
		int i;
		for (i = 0; i < 8; i++)
			fields[i] = 256*a[2*i] + a[2*i+1];

		/* Check for IPv4-mapped address */
		int v4mapped = 0;
		if (fields[0]==0 && fields[1]==0 && fields[2]==0 &&
		    fields[3]==0 && fields[4]==0 && fields[5]==0xffff)
			v4mapped = 1;

		/* Find longest run of consecutive zero fields (>= 2).
		 * Prefer leftmost if tied (RFC 5952 Section 4.2.3). */
		int best_start = -1, best_len = 0;
		int nfields = v4mapped ? 6 : 8;
		for (i = 0; i < nfields; ) {
			if (fields[i] != 0) { i++; continue; }
			int start = i;
			while (i < nfields && fields[i] == 0) i++;
			int len = i - start;
			if (len >= 2 && len > best_len) {
				best_start = start;
				best_len = len;
			}
		}

		/* Build output string */
		char buf[64], *p = buf;
		for (i = 0; i < nfields; ) {
			if (i == best_start) {
				*p++ = ':';
				*p++ = ':';
				i += best_len;
				continue;
			}
			if (p > buf && p[-1] != ':') *p++ = ':';
			p += sprintf(p, "%x", fields[i]);
			i++;
		}
		if (v4mapped) {
			p += sprintf(p, ":%d.%d.%d.%d",
				a[12], a[13], a[14], a[15]);
		}
		*p = 0;

		if (strlen(buf) < l) {
			strcpy(s, buf);
			return s;
		}
		break;
	}
	default:
		errno = EAFNOSUPPORT;
		return 0;
	}
	errno = ENOSPC;
	return 0;
}
