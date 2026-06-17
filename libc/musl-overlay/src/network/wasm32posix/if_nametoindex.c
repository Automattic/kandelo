#include <net/if.h>
#include <string.h>

unsigned if_nametoindex(const char *name)
{
	if (!strcmp(name, "eth0")) return 1;
	return 0;
}
