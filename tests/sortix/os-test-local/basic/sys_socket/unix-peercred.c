/* Test SO_PEERCRED (Linux) reports the peer, not the caller.
 *
 * A socketpair and a listener report their creator; an accepted socket
 * reports the process that connected; a connected socket reports the
 * process that listened; a socket with no peer reports {0, -1, -1}. The
 * connect/accept half runs across fork() so the two sides are different
 * processes -- the case a server such as a Wayland compositor relies on. */

#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>

#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "../basic.h"

static struct ucred peercred(int fd, const char *what)
{
	struct ucred cred;
	socklen_t len = sizeof(cred);
	if ( getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) < 0 )
		err(1, "getsockopt SO_PEERCRED %s", what);
	if ( len != sizeof(cred) )
		errx(1, "SO_PEERCRED %s returned length %u", what, (unsigned) len);
	return cred;
}

static void expect_self(struct ucred cred, pid_t pid, const char *what)
{
	if ( cred.pid != pid || cred.uid != geteuid() || cred.gid != getegid() )
		errx(1, "%s: got pid=%d uid=%u gid=%u, want pid=%d uid=%u gid=%u",
		     what, (int) cred.pid, (unsigned) cred.uid, (unsigned) cred.gid,
		     (int) pid, (unsigned) geteuid(), (unsigned) getegid());
}

int main(void)
{
	int pair[2];
	if ( socketpair(AF_UNIX, SOCK_STREAM, 0, pair) < 0 )
		err(1, "socketpair");
	expect_self(peercred(pair[0], "socketpair[0]"), getpid(), "socketpair[0]");
	expect_self(peercred(pair[1], "socketpair[1]"), getpid(), "socketpair[1]");
	close(pair[0]);
	close(pair[1]);

	int lone = socket(AF_UNIX, SOCK_STREAM, 0);
	if ( lone < 0 )
		err(1, "socket");
	struct ucred none = peercred(lone, "unconnected");
	if ( none.pid != 0 || none.uid != (uid_t) -1 || none.gid != (gid_t) -1 )
		errx(1, "unconnected: got pid=%d uid=%u gid=%u, want 0/-1/-1",
		     (int) none.pid, (unsigned) none.uid, (unsigned) none.gid);
	close(lone);

	struct sockaddr_un addr;
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	snprintf(addr.sun_path, sizeof(addr.sun_path),
	         "/tmp/unix-peercred-%d", (int) getpid());
	unlink(addr.sun_path);
	int listener = socket(AF_UNIX, SOCK_STREAM, 0);
	if ( listener < 0 )
		err(1, "socket");
	if ( bind(listener, (const struct sockaddr*) &addr, sizeof(addr)) < 0 )
		err(1, "bind");
	if ( listen(listener, 1) < 0 )
		err(1, "listen");
	expect_self(peercred(listener, "listener"), getpid(), "listener");

	pid_t parent = getpid();
	pid_t child = fork();
	if ( child < 0 )
		err(1, "fork");
	if ( child == 0 )
	{
		close(listener);
		int fd = socket(AF_UNIX, SOCK_STREAM, 0);
		if ( fd < 0 )
			err(1, "child socket");
		if ( connect(fd, (const struct sockaddr*) &addr, sizeof(addr)) < 0 )
			err(1, "child connect");
		/* The client sees the process that called listen(). */
		expect_self(peercred(fd, "client"), parent, "client");
		char byte = 'x';
		if ( write(fd, &byte, 1) != 1 )
			err(1, "child write");
		close(fd);
		_exit(0);
	}

	int conn = accept(listener, NULL, NULL);
	if ( conn < 0 )
		err(1, "accept");
	/* The accepted socket sees the process that called connect(). */
	expect_self(peercred(conn, "accepted"), child, "accepted");
	char byte;
	if ( read(conn, &byte, 1) != 1 || byte != 'x' )
		errx(1, "accepted socket did not receive the child's byte");

	int status;
	if ( waitpid(child, &status, 0) != child )
		err(1, "waitpid");
	if ( !WIFEXITED(status) || WEXITSTATUS(status) != 0 )
		errx(1, "child failed (status 0x%x)", status);
	close(conn);
	close(listener);
	unlink(addr.sun_path);
	return 0;
}
