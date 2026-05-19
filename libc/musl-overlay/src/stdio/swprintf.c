/* musl overlay: swprintf with POSIX XSI EOVERFLOW on truncation.
 * musl's vswprintf returns -1 when output exceeds the buffer but does
 * not set errno = EOVERFLOW as POSIX XSI requires. We override swprintf
 * to wrap the real vswprintf and set errno on failure. */
#include <wchar.h>
#include <errno.h>
#include <stdarg.h>

int swprintf(wchar_t *restrict s, size_t n, const wchar_t *restrict fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	int ret = vswprintf(s, n, fmt, ap);
	va_end(ap);
	if (ret < 0) {
		errno = EOVERFLOW;
	}
	return ret;
}
