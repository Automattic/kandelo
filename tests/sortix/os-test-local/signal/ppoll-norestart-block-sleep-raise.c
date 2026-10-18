/* Test a SIGUSR1 that a child process sends while ppoll() waits with
   SIGUSR1 unblocked, with a handler
   installed by sigaction() WITHOUT SA_RESTART.

   POSIX ppoll(): "If a signal is unmasked as a result of the signal mask being
   altered by ppoll(), and a signal-catching function is called for that
   signal during the execution of the ppoll() function, and SA_RESTART is
   clear for the interrupting signal, then [if] none of the defined events
   have occurred on any selected file descriptor, ppoll() shall immediately
   fail with the [EINTR] error after the signal-catching function returns."

   Kandelo replacement for upstream signal/ppoll-block{,-sleep}-raise, which
   use signal() and so depend on its implementation-defined sa_flags. */

#include "signal/signal.h"

static int write_end = -1;

static void handler(int signum)
{
	(void) signum;
	int errnum = errno;
	printf("SIGUSR1\n");
	fflush(stdout);

	errno = errnum;
}

int main(void)
{
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = handler;
	sigemptyset(&sa.sa_mask);
	sa.sa_flags = 0;
	if ( sigaction(SIGUSR1, &sa, NULL) )
		err(1, "sigaction");
	sigset_t sigusr1;
	sigemptyset(&sigusr1);
	sigaddset(&sigusr1, SIGUSR1);
	sigprocmask(SIG_BLOCK, &sigusr1, NULL);
	sigset_t empty;
	sigemptyset(&empty);

	int fds[2];
	if ( pipe(fds) )
		err(1, "pipe");
	write_end = fds[1];
	pid_t parent = getpid();
	pid_t pid = fork();
	if ( pid < 0 )
		err(1, "fork");
	if ( !pid )
	{
		/* Drop the child's copies so only the parent's write end remains. */
		close(fds[0]);
		close(fds[1]);
		// Race condition since we can't observe if ppoll is truly waiting.
		usleep(100 * 1000);
		kill(parent, SIGUSR1);
		_Exit(0);
	}
	struct pollfd pfd = { .fd = fds[0], .events = POLLIN };
	int ret = ppoll(&pfd, 1, NULL, &empty);
	if ( ret < 0 )
		err(1, "ppoll");
	if ( !ret )
	{
		printf("ppoll() == 0\n");
		return 0;
	}
	printf("0");
	if ( pfd.revents & POLLIN )
		printf(" | POLLIN");
	if ( pfd.revents & POLLOUT )
		printf(" | POLLOUT");
	if ( pfd.revents & POLLERR )
		printf(" | POLLERR");
	if ( pfd.revents & POLLHUP )
		printf(" | POLLHUP");
	if ( pfd.revents & POLLNVAL )
		printf(" | POLLNVAL");
	printf("\n");
	return 0;
}
