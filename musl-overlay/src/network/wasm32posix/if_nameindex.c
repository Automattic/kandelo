#include <net/if.h>
#include <stdlib.h>
#include <string.h>

struct if_nameindex *if_nameindex(void)
{
	/* Return a synthetic loopback interface */
	struct if_nameindex *idx = malloc(2 * sizeof(*idx));
	if (!idx) return 0;
	idx[0].if_index = 1;
	idx[0].if_name = strdup("lo");
	if (!idx[0].if_name) {
		free(idx);
		return 0;
	}
	idx[1].if_index = 0;
	idx[1].if_name = 0;
	return idx;
}
