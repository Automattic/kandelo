/*
 * checkpoint-dlopen.c — a checkpoint whose pthread replica is behind.
 *
 * Test fixture for the machine checkpoint
 * (host/test/migration/machine-checkpoint.test.ts). The pthread starts before
 * the main thread loads the side module, so the pthread's copy of the
 * dynamic-loader archive is one generation old when the freeze arrives. It has
 * to adopt the newer generation before it can capture, and adopting needs the
 * archive writer, which no thread can take while a peer parked in the same
 * freeze holds a reader.
 *
 * The naps are the ordering. The main thread wakes every millisecond and
 * reaches the freeze first, so it is the peer holding the reader. The pthread
 * wakes every fifty, so it asks for the writer with the main thread already
 * parked.
 *
 * Its argument is the path of the side module to load. It never exits on its
 * own. Its test destroys the machine.
 */
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void nap(long nanoseconds) {
	struct timespec interval = { .tv_sec = 0, .tv_nsec = nanoseconds };
	nanosleep(&interval, NULL);
}

static void *tick(void *unused) {
	(void)unused;
	for (;;) nap(50000000);
	return NULL;
}

int main(int argc, char *argv[]) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	if (argc < 2) {
		printf("USAGE\n");
		return 1;
	}
	// The instrumenter grants the dylink-main fork role only to a module that
	// imports kernel.kernel_fork, and a fork-instrumented main without that
	// role refuses dlopen. One real fork keeps the fixture an ordinary
	// fork-capable dlopen user.
	if (fork() == 0) return 0;
	wait(NULL);
	pthread_t thread;
	if (pthread_create(&thread, NULL, tick, NULL) != 0) {
		printf("THREAD_FAILED\n");
		return 1;
	}
	// The load must follow the thread's first nap, or the thread adopts the
	// new generation at startup and nothing is ever behind.
	nap(100000000);
	void *library = dlopen(argv[1], RTLD_NOW);
	if (!library) {
		printf("DLOPEN_FAILED %s\n", dlerror());
		return 1;
	}
	printf("READY\n");
	for (;;) nap(1000000);
	return 0;
}
