#include <net/if.h>
#include <stdlib.h>

void if_freenameindex(struct if_nameindex *idx)
{
	if (!idx) return;
	for (struct if_nameindex *p = idx; p->if_index || p->if_name; p++)
		free(p->if_name);
	free(idx);
}
