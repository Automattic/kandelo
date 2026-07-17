#include <stdlib.h>
#include <string.h>
#include "locale_name_impl.h"

#define malloc __libc_malloc
#define free __libc_free

struct locale_name_cache {
	struct locale_name_cache *next;
	locale_t locale;
	char name[LOCALE_NAME_BUFSIZE];
};

static struct locale_name_cache *locale_name_cache;

/* Entries belong to locale objects and are removed by successful in-place
 * newlocale calls and by freelocale. Builtin locale objects have fixed lifetime. */

static const char *category_name(locale_t locale, int category)
{
	const struct __locale_map *map = locale->cat[category];
	return map ? map->name : "C";
}

hidden const char *__locale_name_locked(locale_t locale,
	char name[LOCALE_NAME_BUFSIZE])
{
	char *p = name;

	for (int i = 1; i < LC_ALL; i++)
		if (locale->cat[i] != locale->cat[0]) goto composite;
	return category_name(locale, LC_CTYPE);

composite:
	for (int i = 0; i < LC_ALL; i++) {
		const char *part = category_name(locale, i);
		size_t len = strlen(part);
		if (i) *p++ = LOCALE_NAME_SEPARATOR;
		memcpy(p, part, len);
		p += len;
	}
	*p = 0;
	return name;
}

hidden const char *__locale_name_cached_locked(locale_t locale)
{
	char name[LOCALE_NAME_BUFSIZE];
	const char *serialized;

	for (struct locale_name_cache *entry = locale_name_cache;
	     entry; entry = entry->next)
		if (entry->locale == locale) return entry->name;

	serialized = __locale_name_locked(locale, name);
	if (serialized != name) return serialized;

	struct locale_name_cache *entry = malloc(sizeof *entry);
	if (!entry) return 0;
	entry->next = locale_name_cache;
	entry->locale = locale;
	strcpy(entry->name, name);
	locale_name_cache = entry;
	return entry->name;
}

hidden void __locale_name_cache_remove_locked(locale_t locale)
{
	struct locale_name_cache **link = &locale_name_cache;

	while (*link) {
		struct locale_name_cache *entry = *link;
		if (entry->locale != locale) {
			link = &entry->next;
			continue;
		}
		*link = entry->next;
		free(entry);
	}
}
