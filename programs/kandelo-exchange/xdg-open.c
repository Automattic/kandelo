/* xdg-open: open a link in the user's browser through Kandelo exchange.
 *
 *   xdg-open URI
 *
 * An http, https or mailto URI is published as a text/uri-list output; the
 * host shows it to the user, whose click opens it. xdg-open returns once the
 * output is published, as the real one returns once it has started a
 * browser. Exit status, as in xdg-utils: 0 published, 1 bad usage, 3 any
 * other argument (no tool here opens it), 4 the publish failed (ENXIO when
 * no host takes outputs). */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <kandelo/exchange.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/xattr.h>
#include <unistd.h>

#include "kx-util.h"

#define MIME_URI_LIST "text/uri-list"

static int failed(const char *what, const char *path)
{
	fprintf(stderr, "xdg-open: %s %s: %s\n", what, path, strerror(errno));
	return 4;
}

static int has_scheme(const char *uri, const char *scheme)
{
	return strncasecmp(uri, scheme, strlen(scheme)) == 0;
}

int main(int argc, char **argv)
{
	if (argc != 2 || argv[1][0] == '-') {
		fprintf(stderr, "usage: xdg-open URI\n");
		return 1;
	}
	const char *uri = argv[1];
	if (!has_scheme(uri, "http://") && !has_scheme(uri, "https://") && !has_scheme(uri, "mailto:")) {
		fprintf(stderr, "xdg-open: only http, https and mailto URIs are supported\n");
		return 3;
	}
	if (strpbrk(uri, "\r\n")) {
		fprintf(stderr, "xdg-open: a URI cannot contain a line break\n");
		return 1;
	}

	char session[256];
	int session_fd = kx_session_open(session, sizeof session);
	if (session_fd < 0) return failed("open a work session", KX_CLONE);

	/* outbox/ refuses a name already published, and an earlier link may
	 * still wait for the user. */
	char name[32], staged[512];
	snprintf(name, sizeof name, "link-%d.uri", (int)getpid());
	snprintf(staged, sizeof staged, "%s/%s", session, name);
	int out = open(staged, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
	if (out < 0) return failed("create", staged);
	int written = kx_write_all(out, uri, strlen(uri)) == 0 && kx_write_all(out, "\r\n", 2) == 0;
	if (close(out) != 0 || !written) return failed("write", staged);
	if (setxattr(staged, KX_XATTR_MIME_TYPE, MIME_URI_LIST, strlen(MIME_URI_LIST), 0) != 0)
		return failed("set the type of", staged);
	if (kx_publish(staged, name, NULL) != 0) return failed("publish", staged);
	close(session_fd);
	return 0;
}
