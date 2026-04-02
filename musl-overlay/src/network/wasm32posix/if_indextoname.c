#include <net/if.h>
#include <string.h>
#include <errno.h>

char *if_indextoname(unsigned index, char *name)
{
	if (index == 1)
		return strncpy(name, "lo", IF_NAMESIZE);
	errno = ENXIO;
	return 0;
}
