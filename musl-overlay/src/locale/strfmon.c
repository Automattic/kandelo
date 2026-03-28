/* strfmon - format monetary value
 *
 * Fixed version: properly handles POSIX locale where mon_decimal_point
 * is empty (decimal point removed), fill characters, field width, and
 * negative sign placement.
 */

#include <stdio.h>
#include <string.h>
#include <ctype.h>
#include <stdarg.h>
#include <monetary.h>
#include <locale.h>
#include <limits.h>
#include <errno.h>
#include "locale_impl.h"

static ssize_t vstrfmon_l(char *s, size_t n, locale_t loc, const char *fmt, va_list ap)
{
	size_t l;
	double x;
	int fill, nogrp, negpar, nosym, left, intl;
	int lp, rp, fw;
	char *s0 = s;
	struct lconv *lc = localeconv();

	for (; n && *fmt; ) {
		if (*fmt != '%') {
		literal:
			*s++ = *fmt++;
			n--;
			continue;
		}
		fmt++;
		if (*fmt == '%') goto literal;

		fill = ' ';
		nogrp = 0;
		negpar = 0;
		nosym = 0;
		left = 0;
		for (; ; fmt++) {
			switch (*fmt) {
			case '=':
				fill = *++fmt;
				continue;
			case '^':
				nogrp = 1;
				continue;
			case '(':
				negpar = 1;
				continue;
			case '+':
				continue;
			case '!':
				nosym = 1;
				continue;
			case '-':
				left = 1;
				continue;
			}
			break;
		}

		for (fw = 0; isdigit(*fmt); fmt++)
			fw = 10*fw + (*fmt - '0');
		lp = -1;
		rp = 2;
		if (*fmt == '#') for (lp = 0, fmt++; isdigit(*fmt); fmt++)
			lp = 10*lp + (*fmt - '0');
		if (*fmt == '.') for (rp = 0, fmt++; isdigit(*fmt); fmt++)
			rp = 10*rp + (*fmt - '0');

		intl = *fmt++ == 'i';

		x = va_arg(ap, double);

		/* Determine sign */
		int neg = x < 0;
		if (neg) x = -x;

		/* Determine sign string.
		 * POSIX: when p_sign_posn/n_sign_posn is CHAR_MAX and neither
		 * + nor ( was specified, use "" for positive, "-" for negative. */
		const char *sign = "";
		if (neg) {
			const char *ns = lc->negative_sign;
			int nsp = intl ? lc->int_n_sign_posn : lc->n_sign_posn;
			if (nsp == (char)CHAR_MAX)
				sign = "-";
			else if (ns && *ns)
				sign = ns;
			else
				sign = "-";
		}

		/* Format the number with requested precision */
		char numbuf[128];
		snprintf(numbuf, sizeof numbuf, "%.*f", rp, x);

		/* Split into integer and fractional parts at the decimal point */
		char *dot = strchr(numbuf, '.');
		char intpart[64], fracpart[64];
		if (dot) {
			size_t ilen = dot - numbuf;
			memcpy(intpart, numbuf, ilen);
			intpart[ilen] = 0;
			strcpy(fracpart, dot + 1);
		} else {
			strcpy(intpart, numbuf);
			fracpart[0] = 0;
		}

		/* Build the formatted number: sign + fill + intpart + radix + fracpart */
		char result[256];
		char *p = result;

		/* Add sign prefix */
		size_t slen = strlen(sign);
		memcpy(p, sign, slen);
		p += slen;

		/* Left-digit padding with fill character */
		int intlen = strlen(intpart);
		if (lp >= 0 && intlen < lp) {
			int pad = lp - intlen;
			memset(p, fill, pad);
			p += pad;
		}

		/* Integer part */
		memcpy(p, intpart, intlen);
		p += intlen;

		/* Radix character (mon_decimal_point) and fractional part */
		if (rp > 0) {
			const char *radix = lc->mon_decimal_point;
			if (radix && *radix) {
				size_t rlen = strlen(radix);
				memcpy(p, radix, rlen);
				p += rlen;
			}
			/* Always include fractional digits (they're significant) */
			size_t flen = strlen(fracpart);
			memcpy(p, fracpart, flen);
			p += flen;
		}

		*p = 0;
		int resultlen = p - result;

		/* Apply field width */
		if (fw > 0 && resultlen < fw) {
			int pad = fw - resultlen;
			if (left) {
				/* Left-aligned: content then spaces */
				if ((size_t)(resultlen + pad) >= n) {
					errno = E2BIG;
					return -1;
				}
				memcpy(s, result, resultlen);
				memset(s + resultlen, ' ', pad);
				l = resultlen + pad;
			} else {
				/* Right-aligned: spaces then content */
				if ((size_t)(resultlen + pad) >= n) {
					errno = E2BIG;
					return -1;
				}
				memset(s, ' ', pad);
				memcpy(s + pad, result, resultlen);
				l = resultlen + pad;
			}
		} else {
			l = resultlen;
			if (l >= n) {
				errno = E2BIG;
				return -1;
			}
			memcpy(s, result, l);
		}

		s += l;
		n -= l;
	}
	*s = 0;
	return s - s0;
}

ssize_t strfmon_l(char *restrict s, size_t n, locale_t loc, const char *restrict fmt, ...)
{
	va_list ap;
	ssize_t ret;

	va_start(ap, fmt);
	ret = vstrfmon_l(s, n, loc, fmt, ap);
	va_end(ap);

	return ret;
}


ssize_t strfmon(char *restrict s, size_t n, const char *restrict fmt, ...)
{
	va_list ap;
	ssize_t ret;

	va_start(ap, fmt);
	ret = vstrfmon_l(s, n, CURRENT_LOCALE, fmt, ap);
	va_end(ap);

	return ret;
}
