#define _GNU_SOURCE
#include <langinfo.h>
#include <locale.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;

static void expect_string(const char *label, const char *actual,
	const char *expected)
{
	if (!actual || strcmp(actual, expected)) {
		fprintf(stderr, "%s: expected '%s', got '%s'\n", label,
			expected, actual ? actual : "(null)");
		failures++;
	}
}

static void expect_null(const char *label, const char *actual)
{
	if (actual) {
		fprintf(stderr, "%s: expected NULL, got '%s'\n", label, actual);
		failures++;
	}
}

static locale_t make_composite_locale(const char *const names[LC_ALL])
{
	locale_t locale = newlocale(LC_ALL_MASK, names[0], 0);
	if (!locale) return 0;

	for (int category = LC_CTYPE; category < LC_ALL; category++) {
		locale_t updated = newlocale(1 << category, names[category], locale);
		if (!updated) {
			freelocale(locale);
			return 0;
		}
		locale = updated;
	}
	return locale;
}

static void expect_invalid_composite(const char *label, const char *name,
	const char *unchanged)
{
	if (setlocale(LC_ALL, name)) {
		fprintf(stderr, "%s: malformed composite was accepted\n", label);
		failures++;
	}
	expect_string(label, getlocalename_l(LC_ALL, LC_GLOBAL_LOCALE), unchanged);
}

static void check_semicolon_round_trip(void)
{
	static const char *const names[LC_ALL] = {
		"ct;ype", "num;eric", "ti;me",
		"col;late", "mon;etary", "mes;sages",
	};
	static const char encoded[] =
		"ct;ype/num;eric/ti;me/col;late/mon;etary/mes;sages";
	locale_t locale = make_composite_locale(names);
	if (!locale) {
		fputs("semicolon composite locale creation failed\n", stderr);
		failures++;
		return;
	}

	const char *name = getlocalename_l(LC_ALL, locale);
	expect_string("semicolon composite encoding", name, encoded);
	if (!name) {
		freelocale(locale);
		return;
	}
	if (!setlocale(LC_ALL, name)) {
		fputs("semicolon composite setlocale failed\n", stderr);
		failures++;
	} else {
		for (int category = LC_CTYPE; category < LC_ALL; category++)
			expect_string("semicolon category round trip",
				getlocalename_l(category, LC_GLOBAL_LOCALE), names[category]);
		expect_string("semicolon LC_ALL round trip",
			setlocale(LC_ALL, 0), encoded);
	}
	freelocale(locale);

	if (!setlocale(LC_ALL, "one;locale")) {
		fputs("uniform semicolon setlocale failed\n", stderr);
		failures++;
		return;
	}
	for (int category = LC_CTYPE; category < LC_ALL; category++)
		expect_string("uniform semicolon category",
			getlocalename_l(category, LC_GLOBAL_LOCALE), "one;locale");
	expect_string("uniform semicolon LC_ALL",
		getlocalename_l(LC_ALL, LC_GLOBAL_LOCALE), "one;locale");
	expect_invalid_composite("missing composite field",
		"bad-0/bad-1/bad-2/bad-3/bad-4", "one;locale");
	expect_invalid_composite("extra composite field",
		"bad-0/bad-1/bad-2/bad-3/bad-4/bad-5/bad-6", "one;locale");
	expect_invalid_composite("empty composite field",
		"bad-0/bad-1//bad-3/bad-4/bad-5", "one;locale");
}

static void *replace_global_locale(void *arg)
{
	const char *encoded = arg;
	if (!setlocale(LC_ALL, encoded)) {
		fputs("worker setlocale failed\n", stderr);
		failures++;
		return 0;
	}
	expect_string("worker global locale",
		getlocalename_l(LC_ALL, LC_GLOBAL_LOCALE), encoded);
	return 0;
}

static void check_global_thread_buffer(void)
{
	static const char main_name[] = "main-0/main-1/main-2/main-3/main-4/main-5";
	static const char worker_name[] =
		"worker-0/worker-1/worker-2/worker-3/worker-4/worker-5";
	pthread_t thread;

	if (!setlocale(LC_ALL, main_name)) {
		fputs("main thread setlocale failed\n", stderr);
		failures++;
		return;
	}
	const char *saved = getlocalename_l(LC_ALL, LC_GLOBAL_LOCALE);
	expect_string("main global locale", saved, main_name);
	if (pthread_create(&thread, 0, replace_global_locale, (void *)worker_name)) {
		fputs("pthread_create failed\n", stderr);
		failures++;
		return;
	}
	if (pthread_join(thread, 0)) {
		fputs("pthread_join failed\n", stderr);
		failures++;
		return;
	}
	expect_string("main global buffer after worker query", saved, main_name);
}

static void select_cache_names(unsigned value,
	const char *selected[LC_ALL])
{
	static const char *const names[] = {
		"cache-0", "cache-1", "cache-2",
		"cache-3", "cache-4", "cache-5",
	};

	for (int category = LC_CTYPE; category < LC_ALL; category++) {
		selected[category] = names[value % 6];
		value /= 6;
	}
}

static void check_cache_lifecycle(void)
{
	const char *selected[LC_ALL];
	char expected[128];
	locale_t locale;

	select_cache_names(0, selected);
	locale = make_composite_locale(selected);
	if (!locale) {
		fputs("cache stress locale creation failed\n", stderr);
		failures++;
		return;
	}

	/* Exercise every combination of six retained locale maps. Each successful
	 * in-place newlocale call invalidates the prior composite-name pointer. */
	for (unsigned value = 0; value < 46656; value++) {
		select_cache_names(value, selected);
		for (int category = LC_CTYPE; category < LC_ALL; category++) {
			locale_t updated = newlocale(1 << category,
				selected[category], locale);
			if (!updated) {
				fputs("cache stress newlocale failed\n", stderr);
				failures++;
				freelocale(locale);
				return;
			}
			locale = updated;
		}
		int uniform = 1;
		for (int category = LC_NUMERIC; category < LC_ALL; category++)
			if (strcmp(selected[category], selected[LC_CTYPE])) uniform = 0;
		if (uniform) {
			snprintf(expected, sizeof expected, "%s", selected[LC_CTYPE]);
		} else {
			snprintf(expected, sizeof expected, "%s/%s/%s/%s/%s/%s",
				selected[0], selected[1], selected[2], selected[3],
				selected[4], selected[5]);
		}
		const char *actual = getlocalename_l(LC_ALL, locale);
		if (!actual || strcmp(actual, expected)) {
			fprintf(stderr, "cache stress %u: expected '%s', got '%s'\n",
				value, expected, actual ? actual : "(null)");
			failures++;
			break;
		}
	}
	freelocale(locale);

	/* Repeatedly free a locale while it owns a cached composite name. */
	for (unsigned value = 0; value < 256; value++) {
		select_cache_names(value, selected);
		locale = make_composite_locale(selected);
		if (!locale || !getlocalename_l(LC_ALL, locale)) {
			fputs("cache free stress failed\n", stderr);
			failures++;
			if (locale) freelocale(locale);
			return;
		}
		freelocale(locale);
	}
}

static void check_alternative_months(locale_t locale)
{
	static const nl_item full_items[] = {
		ALTMON_1, ALTMON_2, ALTMON_3, ALTMON_4, ALTMON_5, ALTMON_6,
		ALTMON_7, ALTMON_8, ALTMON_9, ALTMON_10, ALTMON_11, ALTMON_12,
	};
	static const nl_item abbreviated_items[] = {
		ABALTMON_1, ABALTMON_2, ABALTMON_3, ABALTMON_4, ABALTMON_5,
		ABALTMON_6, ABALTMON_7, ABALTMON_8, ABALTMON_9, ABALTMON_10,
		ABALTMON_11, ABALTMON_12,
	};
	static const char *const full_names[] = {
		"January", "February", "March", "April", "May", "June",
		"July", "August", "September", "October", "November", "December",
	};
	static const char *const abbreviated_names[] = {
		"Jan", "Feb", "Mar", "Apr", "May", "Jun",
		"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
	};
	char label[32];

	for (size_t i = 0; i < 12; i++) {
		snprintf(label, sizeof label, "ALTMON_%zu", i + 1);
		expect_string(label, nl_langinfo_l(full_items[i], locale), full_names[i]);
		snprintf(label, sizeof label, "ABALTMON_%zu", i + 1);
		expect_string(label, nl_langinfo_l(abbreviated_items[i], locale),
			abbreviated_names[i]);
	}
}

int main(void)
{
	locale_t locale;
	locale_t copy;

	if (!setlocale(LC_ALL, "C")) {
		fputs("setlocale(C) failed\n", stderr);
		return 1;
	}
	expect_string("global C category",
		getlocalename_l(LC_TIME, LC_GLOBAL_LOCALE), "C");
	expect_string("global C LC_ALL",
		getlocalename_l(LC_ALL, LC_GLOBAL_LOCALE), "C");

	locale = newlocale(LC_ALL_MASK, "en_US.UTF-8", 0);
	if (!locale) {
		fputs("newlocale(en_US.UTF-8) failed\n", stderr);
		return 1;
	}
	for (int category = LC_CTYPE; category < LC_ALL; category++)
		expect_string("named locale category",
			getlocalename_l(category, locale), "en_US.UTF-8");
	expect_string("named locale LC_ALL",
		getlocalename_l(LC_ALL, locale), "en_US.UTF-8");
	freelocale(locale);

	locale = newlocale(LC_ALL_MASK, "C", 0);
	locale = newlocale(LC_TIME_MASK, "fr_FR.UTF-8", locale);
	if (!locale) {
		fputs("newlocale(composite) failed\n", stderr);
		return 1;
	}
	expect_string("composite CTYPE", getlocalename_l(LC_CTYPE, locale), "C");
	expect_string("composite TIME",
		getlocalename_l(LC_TIME, locale), "fr_FR.UTF-8");
	expect_string("composite LC_ALL", getlocalename_l(LC_ALL, locale),
		"C/C/fr_FR.UTF-8/C/C/C");

	copy = duplocale(locale);
	if (!copy) {
		fputs("duplocale failed\n", stderr);
		return 1;
	}
	expect_string("duplicated TIME",
		getlocalename_l(LC_TIME, copy), "fr_FR.UTF-8");
	expect_string("duplicated LC_ALL", getlocalename_l(LC_ALL, copy),
		"C/C/fr_FR.UTF-8/C/C/C");
	freelocale(copy);
	freelocale(locale);

	if (!setlocale(LC_TIME, "de_DE.UTF-8")) {
		fputs("setlocale(de_DE.UTF-8) failed\n", stderr);
		return 1;
	}
	expect_string("global named TIME",
		getlocalename_l(LC_TIME, LC_GLOBAL_LOCALE), "de_DE.UTF-8");
	expect_string("global composite LC_ALL",
		getlocalename_l(LC_ALL, LC_GLOBAL_LOCALE),
		"C/C/de_DE.UTF-8/C/C/C");
	expect_null("invalid category", getlocalename_l(LC_ALL + 1, LC_GLOBAL_LOCALE));
	check_semicolon_round_trip();
	check_global_thread_buffer();
	check_cache_lifecycle();

	locale = newlocale(LC_ALL_MASK, "C", 0);
	if (!locale) {
		fputs("newlocale(C) failed\n", stderr);
		return 1;
	}
	check_alternative_months(locale);
	freelocale(locale);
	setlocale(LC_ALL, "C");

	if (failures) return 1;
	puts("locale-info-ok");
	return 0;
}
