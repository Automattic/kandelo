#include <wchar.h>

size_t wcslcpy(wchar_t *restrict dst, const wchar_t *restrict src, size_t n)
{
	size_t srclen = wcslen(src);
	if (n) {
		size_t copy = srclen < n - 1 ? srclen : n - 1;
		wmemcpy(dst, src, copy);
		dst[copy] = L'\0';
	}
	return srclen;
}
