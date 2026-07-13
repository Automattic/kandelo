#include <stdlib.h>
#include "locale_impl.h"
#include "locale_name_impl.h"
#include "lock.h"

#define malloc undef
#define calloc undef
#define realloc undef
#define free __libc_free

void freelocale(locale_t locale)
{
	if (!__loc_is_allocated(locale)) return;

	LOCK(__locale_lock);
	__locale_name_cache_remove_locked(locale);
	free(locale);
	UNLOCK(__locale_lock);
}

weak_alias(freelocale, __freelocale);
