/*
 * spawn-pause.c — sleeps a moment before exiting.
 *
 * Test fixture for `spawn-coverage.c`'s SETPGROUP subtest: gives the
 * parent time to call `getpgid(child)` before the child becomes a
 * zombie. (Our kernel doesn't preserve zombie state across waitpid;
 * this is an orthogonal limitation tracked separately.)
 *
 * Exits 0 unconditionally.
 */

#include <unistd.h>

int main(void) {
	usleep(100000); /* 100 ms */
	return 0;
}
