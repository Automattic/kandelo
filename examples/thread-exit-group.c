#include <stdio.h>
#include <stdlib.h>
#include <threads.h>

static int worker(void *arg)
{
	(void)arg;
	exit(0);
}

int main(void)
{
	thrd_t thread;
	if (thrd_create(&thread, worker, NULL) != thrd_success) {
		fputs("thrd_create failed\n", stderr);
		return 2;
	}

	/* Keep the main thread blocked in a retryable syscall while the worker
	 * exits the whole process. This exercises host reaping for exit_group
	 * from a non-main thread. */
	struct timespec delay = { .tv_sec = 1, .tv_nsec = 0 };
	for (;;) {
		thrd_sleep(&delay, NULL);
	}
}
