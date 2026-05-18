/* Replacement qsort_r using heapsort.
 *
 * musl's smoothsort corrupts arrays on wasm32 due to shift-by-32
 * undefined behavior in the shl()/shr() helpers (size_t is 32-bit
 * on wasm32, shifting a uint32_t by 32 is UB). This heapsort is
 * O(n log n) worst-case, in-place, and avoids the problematic
 * bit manipulation.
 */

#define _BSD_SOURCE
#include <stdint.h>
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

static void sift_down(char *base, size_t width, size_t start, size_t end,
                       cmpfun cmp, void *arg)
{
	size_t root = start;
	while (2 * root + 1 <= end) {
		size_t child = 2 * root + 1;
		size_t target = root;

		if (cmp(base + target * width, base + child * width, arg) < 0)
			target = child;
		if (child + 1 <= end &&
		    cmp(base + target * width, base + (child + 1) * width, arg) < 0)
			target = child + 1;
		if (target == root)
			return;
		swap(base + root * width, base + target * width, width);
		root = target;
	}
}

void __qsort_r(void *base, size_t nel, size_t width, cmpfun cmp, void *arg)
{
	char *b = base;
	size_t i;

	if (nel < 2)
		return;

	/* Build max-heap */
	i = (nel - 2) / 2;
	for (;;) {
		sift_down(b, width, i, nel - 1, cmp, arg);
		if (i == 0) break;
		i--;
	}

	/* Extract elements */
	for (i = nel - 1; i > 0; i--) {
		swap(b, b + i * width, width);
		sift_down(b, width, 0, i - 1, cmp, arg);
	}
}

weak_alias(__qsort_r, qsort_r);
