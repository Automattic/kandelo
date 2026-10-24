/* kandelo-publish: publish an output through Kandelo exchange.
 *
 *   kandelo-publish [--mime TYPE] [--from ID]... [--name NAME] FILE
 *       Stage FILE in the work session ($KANDELO_WORK, or a session of its
 *       own), copying it there if it is elsewhere, set its metadata, publish
 *       it as outbox/NAME (default: FILE's name), and print its output ID.
 *   kandelo-publish --stream --name NAME [--mime TYPE] [--from ID]... -- CMD [ARGS...]
 *       Publish a FIFO and run CMD with its stdout on it. The stream is
 *       declared `complete` only if CMD exits 0, `aborted exit N` or
 *       `aborted signal N` otherwise. (There is deliberately no form that
 *       reads its own stdin: it could not tell a finished producer from a
 *       crashed one.)
 *   kandelo-publish --complete PATH
 *   kandelo-publish --abort PATH REASON
 *       Declare how a published stream ended, for programs that manage
 *       their own streams. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <kandelo/exchange.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <unistd.h>

#include "kx-util.h"

extern char **environ;

static int usage(void)
{
	fprintf(stderr,
		"usage: kandelo-publish [--mime TYPE] [--from ID]... [--name NAME] FILE\n"
		"       kandelo-publish --stream --name NAME [--mime TYPE] [--from ID]... -- CMD [ARGS...]\n"
		"       kandelo-publish --complete PATH\n"
		"       kandelo-publish --abort PATH REASON\n");
	return 64;
}

static int die(const char *what, const char *path)
{
	fprintf(stderr, "kandelo-publish: %s %s: %s\n", what, path, strerror(errno));
	return 1;
}

/* Copy `from` into the new file `to`. */
static int copy_file(const char *from, const char *to)
{
	char buffer[65536];
	ssize_t n;
	int in = open(from, O_RDONLY), out;
	if (in < 0) return -1;
	out = open(to, O_WRONLY | O_CREAT | O_EXCL, 0644);
	if (out < 0) {
		close(in);
		return -1;
	}
	while ((n = read(in, buffer, sizeof buffer)) > 0)
		if (kx_write_all(out, buffer, (size_t)n) != 0) break;
	int saved = errno;
	close(in);
	if (close(out) != 0 || n != 0) {
		unlink(to);
		errno = n < 0 ? saved : errno ? errno : EIO;
		return -1;
	}
	return 0;
}

static int set_metadata(const char *path, const char *mime, char *const *from, int from_count)
{
	char list[64 * KX_ID_SIZE + 1] = "";
	size_t used = 0;
	if (mime && setxattr(path, KX_XATTR_MIME_TYPE, mime, strlen(mime), 0) != 0) return -1;
	if (from_count == 0) return 0;
	for (int i = 0; i < from_count; i++) {
		if (strlen(from[i]) != KX_ID_SIZE - 1) {
			errno = EINVAL;
			return -1;
		}
		used += (size_t)snprintf(list + used, sizeof list - used, "%s\n", from[i]);
	}
	return setxattr(path, KX_XATTR_DERIVED_FROM, list, used, 0);
}

static const char *base_name(const char *path)
{
	const char *slash = strrchr(path, '/');
	return slash ? slash + 1 : path;
}

int main(int argc, char **argv)
{
	const char *mime = NULL, *name = NULL;
	char *from[64];
	int from_count = 0, stream = 0, i;

	if (argc == 3 && strcmp(argv[1], "--complete") == 0) {
		if (kx_stream_end(argv[2], NULL) != 0) return die("declare complete", argv[2]);
		return 0;
	}
	if (argc == 4 && strcmp(argv[1], "--abort") == 0) {
		if (kx_stream_end(argv[2], argv[3]) != 0) return die("declare aborted", argv[2]);
		return 0;
	}
	for (i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--mime") == 0 && i + 1 < argc) mime = argv[++i];
		else if (strcmp(argv[i], "--name") == 0 && i + 1 < argc) name = argv[++i];
		else if (strcmp(argv[i], "--from") == 0 && i + 1 < argc && from_count < 64) from[from_count++] = argv[++i];
		else if (strcmp(argv[i], "--stream") == 0) stream = 1;
		else if (strcmp(argv[i], "--") == 0) { i++; break; }
		else if (argv[i][0] == '-') return usage();
		else break;
	}

	/* The session: the caller's, or one of our own for the publish. */
	char own_session[256];
	const char *session = getenv("KANDELO_WORK");
	int session_fd = -1;
	if (!session || !*session) {
		session_fd = kx_session_open(own_session, sizeof own_session);
		if (session_fd < 0) return die("open a work session", KX_CLONE);
		session = own_session;
	}

	char staged[1024], published[1024], id[KX_ID_SIZE];
	if (stream) {
		pid_t pid;
		int status, out, rc;
		posix_spawn_file_actions_t actions;
		if (!name || i >= argc) return usage();
		snprintf(staged, sizeof staged, "%s/%s", session, name);
		snprintf(published, sizeof published, KX_OUTBOX "/%s", name);
		if (mkfifo(staged, 0600) != 0) return die("create", staged);
		if (set_metadata(staged, mime, from, from_count) != 0) return die("set metadata on", staged);
		if (kx_publish(staged, name, id) != 0) return die("publish", staged);
		printf("%s\n", id);
		fflush(stdout);
		/* Blocks until the host starts reading. */
		out = open(published, O_WRONLY | O_CLOEXEC);
		if (out < 0) return die("open", published);
		posix_spawn_file_actions_init(&actions);
		posix_spawn_file_actions_adddup2(&actions, out, STDOUT_FILENO);
		rc = posix_spawnp(&pid, argv[i], &actions, NULL, argv + i, environ);
		posix_spawn_file_actions_destroy(&actions);
		if (rc != 0) {
			errno = rc;
			kx_stream_end(published, "exit 127");
			close(out);
			return die("run", argv[i]);
		}
		while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
		}
		char reason[64];
		const char *abort_reason = NULL;
		if (WIFSIGNALED(status)) {
			snprintf(reason, sizeof reason, "signal %d", WTERMSIG(status));
			abort_reason = reason;
		} else if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
			snprintf(reason, sizeof reason, "exit %d", WIFEXITED(status) ? WEXITSTATUS(status) : 1);
			abort_reason = reason;
		}
		/* Declared before the last writer closes, so the host sees it at EOF. */
		int declared = kx_stream_end(published, abort_reason) == 0;
		if (!declared) die("declare the end of", published);
		close(out);
		return abort_reason || !declared ? 1 : 0;
	}

	if (i != argc - 1) return usage();
	const char *file = argv[i];
	if (!name) name = base_name(file);
	/* Compare resolved paths: a handler runs in its session, so a relative
	 * name ("out.pdf") is usually already staged. */
	char real_file[PATH_MAX], real_session[PATH_MAX];
	int in_session = 0;
	if (realpath(file, real_file) && realpath(session, real_session)) {
		size_t session_length = strlen(real_session);
		in_session = strncmp(real_file, real_session, session_length) == 0 && real_file[session_length] == '/'
			&& !strchr(real_file + session_length + 1, '/');
	}
	if (in_session && strcmp(base_name(real_file), name) == 0) {
		snprintf(staged, sizeof staged, "%s", real_file);
	} else {
		snprintf(staged, sizeof staged, "%s/%s", session, name);
		if (copy_file(file, staged) != 0) return die("stage", file);
	}
	if (set_metadata(staged, mime, from, from_count) != 0) return die("set metadata on", staged);
	if (kx_publish(staged, name, id) != 0) return die("publish", staged);
	printf("%s\n", id);
	if (session_fd >= 0) close(session_fd);
	return 0;
}
