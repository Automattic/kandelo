/*
 * pthread-trap-child.c - child process whose pthread hits a fatal Wasm trap.
 */

#include <pthread.h>
#include <stdio.h>

static void *trap_thread(void *arg)
{
	(void)arg;
	fputs("pthread-trap-child: before trap\n", stderr);
	fflush(stderr);
	__builtin_trap();
	return (void *)1;
}

int main(void)
{
	pthread_t t;
	void *ret = 0;
	int rc = pthread_create(&t, 0, trap_thread, 0);
	if (rc != 0) {
		fprintf(stderr, "FAIL pthread_create rc=%d\n", rc);
		return 2;
	}

	rc = pthread_join(t, &ret);
	fprintf(stderr, "FAIL pthread_join returned rc=%d ret=%p\n", rc, ret);
	return 88;
}
