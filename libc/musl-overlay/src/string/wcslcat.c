#include <wchar.h>

size_t wcslcat(wchar_t *restrict dst, const wchar_t *restrict src, size_t n)
{
	size_t dstlen = wcsnlen(dst, n);
	if (dstlen == n) return n + wcslen(src);
	size_t srclen = wcslen(src);
	size_t avail = n - dstlen - 1;
	size_t copy = srclen < avail ? srclen : avail;
	wmemcpy(dst + dstlen, src, copy);
	dst[dstlen + copy] = L'\0';
	return dstlen + srclen;
}
