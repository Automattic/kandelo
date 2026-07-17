#include <locale.h>
#include "locale_impl.h"
#include "locale_name_impl.h"
#include "libc.h"
#include "lock.h"

static _Thread_local char global_name[LOCALE_NAME_BUFSIZE];

const char *getlocalename_l(int category, locale_t locale)
{
	const char *name;
	int global;

	if ((unsigned)category > LC_ALL || !locale) return 0;

	LOCK(__locale_lock);
	global = locale == LC_GLOBAL_LOCALE;
	if (global) locale = &libc.global_locale;
	if (category == LC_ALL) {
		name = global
			? __locale_name_locked(locale, global_name)
			: __locale_name_cached_locked(locale);
	} else {
		const struct __locale_map *map = locale->cat[category];
		name = map ? map->name : "C";
	}
	UNLOCK(__locale_lock);
	return name;
}
