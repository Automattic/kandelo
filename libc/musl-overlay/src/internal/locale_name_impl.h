#ifndef LOCALE_NAME_IMPL_H
#define LOCALE_NAME_IMPL_H

#include "locale_impl.h"

/* musl rejects '/' in locale names, so it unambiguously separates categories. */
#define LOCALE_NAME_SEPARATOR '/'
#define LOCALE_NAME_BUFSIZE (LC_ALL * (LOCALE_NAME_MAX + 1))

/* Callers hold __locale_lock while using these helpers. */
hidden const char *__locale_name_locked(locale_t, char[LOCALE_NAME_BUFSIZE]);
hidden const char *__locale_name_cached_locked(locale_t);
hidden void __locale_name_cache_remove_locked(locale_t);

#endif
