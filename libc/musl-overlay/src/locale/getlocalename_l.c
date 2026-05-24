#include <locale.h>

/*
 * POSIX.1-2024 getlocalename_l — return the name of a locale category.
 *
 * musl only supports the "C"/"POSIX" locale, so this always returns "C".
 * For LC_GLOBAL_LOCALE, we return whatever setlocale() would return.
 */
const char *getlocalename_l(int category, locale_t locale)
{
	if (category < LC_CTYPE || category > LC_MESSAGES)
		return NULL;
	/* Both LC_GLOBAL_LOCALE and newlocale-created locales
	 * always use "C" in musl's single-locale implementation. */
	return "C";
}
