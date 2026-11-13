/* Replacement qsort_r using a stable merge sort.
 *
 * musl's smoothsort corrupts arrays on wasm32 due to shift-by-32
 * undefined behavior in the shl()/shr() helpers (size_t is 32-bit
 * on wasm32, shifting a uint32_t by 32 is UB). This merge sort keeps
 * equal elements in their input order, as glibc's qsort does, so
 * programs that sort rows with equal keys show the same order as on
 * Linux. It merges through a buffer of nel/2 elements, and merges in
 * place by rotation when that buffer cannot be allocated.
 */

#define _BSD_SOURCE
#include <errno.h>
#include <stdlib.h>
#include <string.h>

typedef int (*cmpfun)(const void *, const void *, void *);

static void swap(char *a, char *b, size_t width)
{
	char tmp[256];
	while (width > 0) {
		size_t chunk = width < sizeof(tmp) ? width : sizeof(tmp);
		memcpy(tmp, a, chunk);
		memcpy(a, b, chunk);
		memcpy(b, tmp, chunk);
		a += chunk;
		b += chunk;
		width -= chunk;
	}
}

static void reverse(char *base, size_t width, size_t lo, size_t hi)
{
	while (hi - lo > 1) {
		hi--;
		swap(base + lo * width, base + hi * width, width);
		lo++;
	}
}

static void rotate(char *base, size_t width, size_t lo, size_t mid, size_t hi)
{
	reverse(base, width, lo, mid);
	reverse(base, width, mid, hi);
	reverse(base, width, lo, hi);
}

static void merge_in_place(char *base, size_t width, size_t lo, size_t mid,
                           size_t hi, cmpfun cmp, void *arg)
{
	size_t cut1, cut2, n;

	if (lo == mid || mid == hi)
		return;
	if (hi - lo == 2) {
		if (cmp(base + mid * width, base + lo * width, arg) < 0)
			swap(base + lo * width, base + mid * width, width);
		return;
	}

	if (mid - lo > hi - mid) {
		cut1 = lo + (mid - lo) / 2;
		cut2 = mid;
		for (n = hi - mid; n > 0;) {
			size_t half = n / 2;
			if (cmp(base + (cut2 + half) * width, base + cut1 * width, arg) < 0) {
				cut2 += half + 1;
				n -= half + 1;
			} else {
				n = half;
			}
		}
	} else {
		cut2 = mid + (hi - mid) / 2;
		cut1 = lo;
		for (n = mid - lo; n > 0;) {
			size_t half = n / 2;
			if (cmp(base + cut2 * width, base + (cut1 + half) * width, arg) >= 0) {
				cut1 += half + 1;
				n -= half + 1;
			} else {
				n = half;
			}
		}
	}

	rotate(base, width, cut1, mid, cut2);
	mid = cut1 + (cut2 - mid);
	merge_in_place(base, width, lo, cut1, mid, cmp, arg);
	merge_in_place(base, width, mid, cut2, hi, cmp, arg);
}

static void merge(char *base, size_t width, size_t lo, size_t mid, size_t hi,
                  char *tmp, cmpfun cmp, void *arg)
{
	size_t left = 0, nleft = mid - lo, right = mid, out = lo;

	memcpy(tmp, base + lo * width, nleft * width);
	while (left < nleft && right < hi) {
		if (cmp(base + right * width, tmp + left * width, arg) < 0)
			memcpy(base + out++ * width, base + right++ * width, width);
		else
			memcpy(base + out++ * width, tmp + left++ * width, width);
	}
	memcpy(base + out * width, tmp + left * width, (nleft - left) * width);
}

static void sort(char *base, size_t width, size_t lo, size_t hi, char *tmp,
                 cmpfun cmp, void *arg)
{
	size_t mid, i, j;

	if (hi - lo <= 8) {
		for (i = lo + 1; i < hi; i++)
			for (j = i; j > lo && cmp(base + (j - 1) * width, base + j * width, arg) > 0; j--)
				swap(base + (j - 1) * width, base + j * width, width);
		return;
	}

	mid = lo + (hi - lo) / 2;
	sort(base, width, lo, mid, tmp, cmp, arg);
	sort(base, width, mid, hi, tmp, cmp, arg);
	if (cmp(base + (mid - 1) * width, base + mid * width, arg) <= 0)
		return;
	if (tmp)
		merge(base, width, lo, mid, hi, tmp, cmp, arg);
	else
		merge_in_place(base, width, lo, mid, hi, cmp, arg);
}

void __qsort_r(void *base, size_t nel, size_t width, cmpfun cmp, void *arg)
{
	int saved_errno = errno;
	char *tmp;

	if (nel < 2 || width == 0)
		return;

	tmp = malloc(nel / 2 * width);
	errno = saved_errno;
	sort(base, width, 0, nel, tmp, cmp, arg);
	free(tmp);
}

weak_alias(__qsort_r, qsort_r);
