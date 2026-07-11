/* Test queued TCP data, EOF, and valid post-FIN send outcomes. */

#include <sys/socket.h>

#include <errno.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>

#include "tcp.h"

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

int main(void)
{
	if ( signal(SIGPIPE, SIG_IGN) == SIG_ERR )
		err(1, "signal");

	int client_fd;
	int server_fd;
	tcp_connected_pair(&client_fd, &server_fd);

	const char queued[] = "queued-before-close";
	if ( send(server_fd, queued, sizeof(queued), 0) != (ssize_t) sizeof(queued) )
		err(1, "send queued data");
	if ( close(server_fd) < 0 )
		err(1, "close server");

	char buffer[sizeof(queued)];
	ssize_t amount = recv(client_fd, buffer, sizeof(buffer), MSG_WAITALL);
	if ( amount < 0 )
		err(1, "recv queued data");
	if ( amount != (ssize_t) sizeof(queued) ||
	     memcmp(buffer, queued, sizeof(queued)) != 0 )
		errx(1, "queued data was not delivered before EOF");

	amount = recv(client_fd, buffer, sizeof(buffer), 0);
	if ( amount < 0 )
		err(1, "recv EOF");
	if ( amount != 0 )
		errx(1, "recv did not report EOF after peer close");

	const char payload[] = "after-close";
	/*
	 * TCP does not define which send observes a later reset. Accept either a
	 * locally queued write or the transport's truthful EPIPE/ECONNRESET; this
	 * test must not impose an invented operation count.
	 */
	for ( int i = 0; i < 3; i++ ) {
		amount = send(client_fd, payload, sizeof(payload), MSG_NOSIGNAL);
		if ( amount < 0 ) {
			if ( errno != EPIPE && errno != ECONNRESET )
				err(1, "send after peer close");
			break;
		}
		if ( amount != (ssize_t) sizeof(payload) )
			errx(1, "short send after peer close");
	}

	if ( close(client_fd) < 0 )
		err(1, "close client");
	return 0;
}
