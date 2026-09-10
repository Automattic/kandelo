/*
 * An epoll fd names an open file description, not a per-process object.
 *
 * A fork() child's duplicated descriptor therefore refers to the *same*
 * instance: the parent's registrations are visible to the child, and the
 * child's epoll_ctl is visible to the parent. Kandelo used to clear the
 * child's instances at fork, so every epoll call on an inherited descriptor
 * returned EBADF on a descriptor the child legitimately held.
 *
 * The test proves both directions in one program, because a child-only check
 * would also pass against an implementation that merely *copied* the instance
 * into the child.
 *
 * Diagnostics go to stdout rather than through err()/errx(): the runner
 * captures the guest's stdout, so a failure here has to be readable there or
 * it reduces to a bare "exit: 1".
 */

#include <sys/epoll.h>
#include <sys/wait.h>

#include <unistd.h>

#include "../basic.h"

#define PARENT_DATA 0x1111u
#define CHILD_DATA 0x2222u

#define FAILF(...) \
	do { \
		printf("epoll-fork-shares-instance: " __VA_ARGS__); \
		printf("\n"); \
		fflush(stdout); \
		_exit(1); \
	} while (0)

#define FAIL_ERRNO(what) \
	FAILF("%s: %s", (what), strerrno(errno))

int main(void)
{
	int parent_pipe[2];
	int child_pipe[2];
	if ( pipe(parent_pipe) < 0 )
		FAIL_ERRNO("pipe (parent-registered)");
	if ( pipe(child_pipe) < 0 )
		FAIL_ERRNO("pipe (child-registered)");

	int ep = epoll_create1(0);
	if ( ep < 0 )
		FAIL_ERRNO("epoll_create1");

	struct epoll_event interest;
	interest.events = EPOLLIN;
	interest.data.u64 = PARENT_DATA;
	if ( epoll_ctl(ep, EPOLL_CTL_ADD, parent_pipe[0], &interest) < 0 )
		FAIL_ERRNO("epoll_ctl EPOLL_CTL_ADD (parent)");

	/* Make the parent-registered read end ready before the fork so the
	   child observes it without needing a rendezvous. */
	if ( write(parent_pipe[1], "p", 1) != 1 )
		FAIL_ERRNO("write (parent-registered)");

	pid_t pid = fork();
	if ( pid < 0 )
		FAIL_ERRNO("fork");

	if ( pid == 0 )
	{
		struct epoll_event events[4];

		/* The inherited descriptor must reach the instance, and that
		   instance must still carry the parent's registration. */
		int ready = epoll_wait(ep, events, 4, 0);
		if ( ready < 0 )
			FAIL_ERRNO("child epoll_wait on inherited epoll fd");
		if ( ready != 1 )
			FAILF("child saw %i ready, expected 1", ready);
		if ( events[0].data.u64 != PARENT_DATA )
			FAILF("child saw data %llu, expected %u",
			      (unsigned long long) events[0].data.u64,
			      PARENT_DATA);

		/* Register through the child's descriptor. The parent must see
		   it, which a copied instance could not provide. */
		struct epoll_event child_interest;
		child_interest.events = EPOLLIN;
		child_interest.data.u64 = CHILD_DATA;
		if ( epoll_ctl(ep, EPOLL_CTL_ADD, child_pipe[0],
		               &child_interest) < 0 )
			FAIL_ERRNO("child epoll_ctl EPOLL_CTL_ADD");
		if ( write(child_pipe[1], "c", 1) != 1 )
			FAIL_ERRNO("child write");

		_exit(0);
	}

	int status;
	if ( waitpid(pid, &status, 0) != pid )
		FAIL_ERRNO("waitpid");
	if ( !WIFEXITED(status) || WEXITSTATUS(status) != 0 )
		FAILF("child failed (status %i)", status);

	struct epoll_event events[4];
	int ready = epoll_wait(ep, events, 4, 0);
	if ( ready < 0 )
		FAIL_ERRNO("parent epoll_wait");
	if ( ready != 2 )
		FAILF("parent saw %i ready, expected 2 (the child's "
		      "EPOLL_CTL_ADD must be visible through the shared "
		      "open file description)", ready);

	int saw_parent = 0;
	int saw_child = 0;
	for ( int i = 0; i < ready; i++ )
	{
		if ( events[i].data.u64 == PARENT_DATA )
			saw_parent = 1;
		else if ( events[i].data.u64 == CHILD_DATA )
			saw_child = 1;
		else
			FAILF("parent saw unexpected data %llu",
			      (unsigned long long) events[i].data.u64);
	}
	if ( !saw_parent )
		FAILF("parent lost its own registration");
	if ( !saw_child )
		FAILF("parent did not see the child's registration");

	if ( close(ep) < 0 )
		FAIL_ERRNO("close epoll");
	return 0;
}
