/* Test TCP peer close EOF and eventual MSG_NOSIGNAL EPIPE behavior. */

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

	if ( close(server_fd) < 0 )
		err(1, "close server");

	char byte;
	ssize_t amount = recv(client_fd, &byte, sizeof(byte), 0);
	if ( amount < 0 )
		err(1, "recv");
	if ( amount != 0 )
		errx(1, "recv did not report EOF after peer close");

	const char payload[] = "after-close";
	amount = send(client_fd, payload, sizeof(payload), MSG_NOSIGNAL);
	if ( amount < 0 )
		err(1, "first send after peer close");

	/*
	 * TCP close is an orderly FIN.  A write after observing peer EOF can
	 * succeed locally; the reset/broken-pipe condition is reported on a later
	 * operation.
	 */
	amount = send(client_fd, payload, sizeof(payload), MSG_NOSIGNAL);
	if ( amount >= 0 )
		errx(1, "second send after peer close unexpectedly succeeded");
	if ( errno != EPIPE && errno != ECONNRESET )
		err(1, "second send after peer close");

	if ( close(client_fd) < 0 )
		err(1, "close client");
	return 0;
}
