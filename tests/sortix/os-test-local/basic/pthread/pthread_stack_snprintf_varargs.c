/* Test pthread initial stack alignment for variadic calls. */

#include <pthread.h>
#include <stdio.h>
#include <string.h>

#include "../basic.h"

struct test_case {
	unsigned long long value;
	const char* expected;
};

static const struct test_case test_cases[] = {
	{ 0x333c7d7900000000ULL, "/tmp/etilqs_333c7d7900000000" },
	{ 0x17887ec000000000ULL, "/tmp/etilqs_17887ec000000000" },
	{ 0x09f49ef200000000ULL, "/tmp/etilqs_9f49ef200000000" },
};

static void check_format(const struct test_case* test)
{
	char buffer[80];
	memset(buffer, 0x5a, sizeof(buffer));

	int ret = snprintf(buffer, sizeof(buffer), "%s/etilqs_%llx%c",
	                   "/tmp", test->value, 0);
	size_t expected_len = strlen(test->expected);
	if ( ret != (int) expected_len + 1 )
		errx(1, "snprintf returned %d, expected %zu", ret,
		     expected_len + 1);
	if ( strlen(buffer) != expected_len )
		errx(1, "snprintf wrote visible length %zu, expected %zu",
		     strlen(buffer), expected_len);
	if ( strcmp(buffer, test->expected) != 0 )
		errx(1, "snprintf wrote '%s', expected '%s'", buffer,
		     test->expected);
	if ( buffer[expected_len] != '\0' || buffer[expected_len + 1] != '\0' )
		errx(1, "snprintf did not write the %%c NUL and terminator");
}

static void* start(void* arg)
{
	check_format((const struct test_case*) arg);
	return NULL;
}

int main(void)
{
	for ( size_t i = 0; i < sizeof(test_cases) / sizeof(test_cases[0]); i++ )
	{
		pthread_t thread;
		int errnum = pthread_create(&thread, NULL, start,
		                            (void*) &test_cases[i]);
		if ( errnum )
		{
			errno = errnum;
			err(1, "pthread_create");
		}
		errnum = pthread_join(thread, NULL);
		if ( errnum )
		{
			errno = errnum;
			err(1, "pthread_join");
		}
	}
	return 0;
}
