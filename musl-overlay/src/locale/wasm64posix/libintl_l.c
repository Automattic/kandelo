#include <locale.h>
#include <libintl.h>

char *gettext_l(const char *msgid, locale_t locale)
{
	return gettext(msgid);
}

char *dgettext_l(const char *domainname, const char *msgid, locale_t locale)
{
	return dgettext(domainname, msgid);
}

char *dcgettext_l(const char *domainname, const char *msgid, int category, locale_t locale)
{
	return dcgettext(domainname, msgid, category);
}

char *ngettext_l(const char *msgid1, const char *msgid2, unsigned long n, locale_t locale)
{
	return ngettext(msgid1, msgid2, n);
}

char *dngettext_l(const char *domainname, const char *msgid1, const char *msgid2, unsigned long n, locale_t locale)
{
	return dngettext(domainname, msgid1, msgid2, n);
}

char *dcngettext_l(const char *domainname, const char *msgid1, const char *msgid2, unsigned long n, int category, locale_t locale)
{
	return dcngettext(domainname, msgid1, msgid2, n, category);
}
