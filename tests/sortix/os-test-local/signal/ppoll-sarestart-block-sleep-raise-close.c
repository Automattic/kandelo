/* Test a SIGUSR1 that a child process sends while ppoll() waits with
   SIGUSR1 unblocked, with a handler
   installed by sigaction() WITH SA_RESTART.

   POSIX sigaction(): if SA_RESTART is set, an interruptible function that is
   interrupted by the signal "shall restart and shall not fail with [EINTR]
   unless otherwise specified". poll()/ppoll() specify EINTR only when
   SA_RESTART is clear (unlike select()/pselect(), where restarting is
   implementation-defined), so ppoll() must restart here. The handler closes
   the pipe's only write end, so the restarted ppoll() reports the hangup
   (POLLHUP; POSIX allows POLLIN alongside it) instead of waiting forever.

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
	close(write_end);
	errno = errnum;
}

int main(void)
{
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = handler;
	sigemptyset(&sa.sa_mask);
	sa.sa_flags = SA_RESTART;
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
