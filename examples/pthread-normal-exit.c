/*
 * pthread-normal-exit.c - verifies normal pthread return and pthread_exit().
 */

#include <pthread.h>
#include <stdint.h>
#include <stdio.h>

static int shared_value;

static void *return_thread(void *arg)
{
	int inc = *(int *)arg;
	shared_value += inc;
	return (void *)(uintptr_t)0x44;
}

static void *exit_thread(void *arg)
{
	int inc = *(int *)arg;
	shared_value += inc;
	pthread_exit((void *)(uintptr_t)0x55);
}

int main(void)
{
	pthread_t a, b;
	void *ret_a = 0;
	void *ret_b = 0;
	int inc_a = 7;
	int inc_b = 11;

	if (pthread_create(&a, 0, return_thread, &inc_a) != 0) {
		puts("FAIL pthread_create return_thread");
		return 1;
	}
	if (pthread_join(a, &ret_a) != 0) {
		puts("FAIL pthread_join return_thread");
		return 2;
	}

	if (pthread_create(&b, 0, exit_thread, &inc_b) != 0) {
		puts("FAIL pthread_create exit_thread");
		return 3;
	}
	if (pthread_join(b, &ret_b) != 0) {
		puts("FAIL pthread_join exit_thread");
		return 4;
	}

	printf("shared_value=%d ret_a=%ld ret_b=%ld\n",
		shared_value,
		(long)(uintptr_t)ret_a,
		(long)(uintptr_t)ret_b);

	if (shared_value != 18) return 5;
	if ((uintptr_t)ret_a != 0x44) return 6;
	if ((uintptr_t)ret_b != 0x55) return 7;

	puts("PASS pthread normal exit");
	return 0;
}
