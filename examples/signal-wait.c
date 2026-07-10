/*
 * signal-wait.c — blocks forever until a signal arrives.
 *
 * Test fixture for host-initiated signal delivery
 * (`CentralizedKernelWorker.signalProcess`, exposed as
 * `NodeKernelHost.signalProcess` / `BrowserKernel.signalProcess`). The process
 * installs no handlers, so a SIGTERM takes its default disposition and
 * terminates it. Never exits on its own, which makes "the process went away"
 * unambiguous evidence that the signal was delivered.
 */

#include <unistd.h>

int main(void) {
	for (;;) {
		pause();
	}
}
