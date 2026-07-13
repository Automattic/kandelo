#include <locale.h>
#include <stdlib.h>
#include <string.h>
#include "locale_impl.h"
#include "locale_name_impl.h"
#include "libc.h"
#include "lock.h"

static char buf[LOCALE_NAME_BUFSIZE];

static int load_composite(struct __locale_struct *locale, const char *name)
{
	const char *p = name;
	char part[LOCALE_NAME_MAX + 1];

	for (int i = 0; i < LC_ALL; i++) {
		const char *end = __strchrnul(p, LOCALE_NAME_SEPARATOR);
		size_t len = end - p;
		if (!len || len > LOCALE_NAME_MAX
		    || (i < LC_ALL - 1 ? !*end : *end))
			return -1;
		memcpy(part, p, len);
		part[len] = 0;
		locale->cat[i] = __get_locale(i, part);
		if (locale->cat[i] == LOC_MAP_FAILED) return -1;
		p = end + 1;
	}
	return 0;
}

static int load_uniform(struct __locale_struct *locale, const char *name)
{
	for (int i = 0; i < LC_ALL; i++) {
		locale->cat[i] = __get_locale(i, name);
		if (locale->cat[i] == LOC_MAP_FAILED) return -1;
	}
	return 0;
}

char *setlocale(int category, const char *name)
{
	const struct __locale_map *map;

	if ((unsigned)category > LC_ALL) return 0;

	LOCK(__locale_lock);

	if (category == LC_ALL) {
		if (name) {
			struct __locale_struct locale;
			int failed = strchr(name, LOCALE_NAME_SEPARATOR)
				? load_composite(&locale, name)
				: load_uniform(&locale, name);
			if (failed) {
				UNLOCK(__locale_lock);
				return 0;
			}
			libc.global_locale = locale;
		}
		char *result = (char *)__locale_name_locked(&libc.global_locale, buf);
		UNLOCK(__locale_lock);
		return result;
	}

	if (name) {
		map = __get_locale(category, name);
		if (map == LOC_MAP_FAILED) {
			UNLOCK(__locale_lock);
			return 0;
		}
		libc.global_locale.cat[category] = map;
	} else {
		map = libc.global_locale.cat[category];
	}
	char *result = map ? (char *)map->name : "C";

	UNLOCK(__locale_lock);
	return result;
}
