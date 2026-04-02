#include <net/if.h>
#include <string.h>

unsigned if_nametoindex(const char *name)
{
	if (!strcmp(name, "lo")) return 1;
	return 0;
}
