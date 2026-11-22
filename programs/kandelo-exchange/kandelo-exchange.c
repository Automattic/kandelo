/* kandelo-exchange: helpers for Kandelo exchange.
 *
 *   kandelo-exchange run [--] CMD [ARGS...]
 *       Open a work session, run CMD with KANDELO_WORK set to it, and exit
 *       with CMD's status. The helper holds the session (its descriptor is
 *       close-on-exec), so it ends when CMD does.
 *   kandelo-exchange ack ID
 *       Remove batch ID from the inbox: the consumer's acknowledgement.
 *   kandelo-exchange handler list
 *   kandelo-exchange handler add NAME [--extension .X]... [--mime TYPE]...
 *                                [--kind file|stream|any] [--max-bytes N]
 *                                --run PROGRAM [ARGS...]
 *   kandelo-exchange handler remove NAME
 *   kandelo-exchange handler mask NAME
 *       Manage rules in /etc/kandelo/exchange-handlers.d/ (NAME.handler).
 *       Changes take effect on the next batch. `list` judges each rule for
 *       the account in /etc/kandelo/exchange.conf, as kxchgd does. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <kandelo/exchange.h>
#include <pwd.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "kx-rules.h"
#include "kx-util.h"

/* Where kxchgd reads the handler account. */
#define KX_CONF "/etc/kandelo/exchange.conf"

extern char **environ;

static int usage(void)
{
	fprintf(stderr,
		"usage: kandelo-exchange run [--] CMD [ARGS...]\n"
		"       kandelo-exchange ack ID\n"
		"       kandelo-exchange handler list\n"
		"       kandelo-exchange handler add NAME [--extension .X]... [--mime TYPE]...\n"
		"           [--kind file|stream|any] [--max-bytes N] --run PROGRAM [ARGS...]\n"
		"       kandelo-exchange handler remove|mask NAME\n");
	return 64;
}

static const char help_text[] =
	"Usage: kandelo-exchange run [--] COMMAND [ARGUMENT]...\n"
	"  or:  kandelo-exchange ack ID\n"
	"  or:  kandelo-exchange handler list\n"
	"  or:  kandelo-exchange handler add NAME [OPTION]... --run PROGRAM [ARG]...\n"
	"  or:  kandelo-exchange handler remove NAME\n"
	"  or:  kandelo-exchange handler mask NAME\n"
	"\n"
	"Run commands in exchange work sessions and manage exchange handlers.\n"
	"\n"
	"Kandelo exchange moves files between the host and the machine through\n"
	"the filesystem mounted at " KX_MOUNT ".\n"
	"\n"
	"run opens a work session, a directory under " KX_WORK "/\n"
	"that exists until kandelo-exchange exits, runs COMMAND (found through\n"
	"PATH) with KANDELO_WORK set to that directory, and waits for it. Files the\n"
	"command leaves unpublished in the session are removed with it; see\n"
	"kandelo-publish(1). The exit status is COMMAND's, 128 plus the signal\n"
	"number if it was killed, or 127 if it could not be started.\n"
	"\n"
	"ack removes the batch directory " KX_INBOX "/ID,\n"
	"which settles the batch. ID is the batch's lowercase UUID.\n"
	"\n"
	"handler manages the rules the exchange agent uses to choose a program\n"
	"for each incoming batch. Rules are NAME.handler files in\n"
	KX_RULES_ETC ", which take precedence over files of\n"
	"the same name in " KX_RULES_VENDOR ".\n"
	"list prints every rule with its source directory and settings, marking\n"
	"rules that are masked or ignored for unsafe ownership or permissions or\n"
	"invalid syntax. It judges them as the exchange agent does, for the\n"
	"account named by \"user NAME\" in " KX_CONF ", which\n"
	"handlers run as; when run by root it reads the rules as that account.\n"
	"list fails if that file names no valid account. add writes a new rule,\n"
	"replacing one of the same name; the batch directory is given to PROGRAM\n"
	"as its first argument, before ARG. remove deletes a rule from\n"
	KX_RULES_ETC ", and mask writes an empty rule there,\n"
	"which disables the rule of that name. Changes apply from the next\n"
	"batch.\n"
	"\n"
	"Exit status is 64 for invalid arguments and 1 for other failures.\n"
	"\n"
	"Options for handler add:\n"
	"      --extension .X   match entries whose names end in .X, ignoring\n"
	"                       case\n"
	"      --mime TYPE      match entries of MIME type TYPE; TYPE/* matches\n"
	"                       every subtype\n"
	"      --kind KIND      accept regular files (file, the default), streamed\n"
	"                       inputs (stream) or both (any)\n"
	"      --max-bytes N    accept regular files of at most N bytes\n"
	"      --run PROGRAM [ARG]...\n"
	"                       the program to run; it takes the rest of the\n"
	"                       command line\n"
	"\n"
	"--extension and --mime may be repeated; an entry matches when any of\n"
	"them matches, and a rule with neither matches every entry. The agent\n"
	"uses the first rule, in file-name order, that matches every top-level\n"
	"entry of the batch.\n"
	"\n"
	"Options:\n"
	"      --help     display this help and exit\n"
	"      --version  output version information and exit\n";

static int exit_status_of(int status)
{
	if (WIFEXITED(status)) return WEXITSTATUS(status);
	if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
	return 1;
}

static int cmd_run(int argc, char **argv)
{
	char session[256];
	pid_t pid;
	int status, fd, rc;
	if (argc > 0 && strcmp(argv[0], "--") == 0) {
		argv++;
		argc--;
	}
	if (argc == 0) return usage();
	fd = kx_session_open(session, sizeof session);
	if (fd < 0) {
		fprintf(stderr, "kandelo-exchange: cannot open a work session: %s\n", strerror(errno));
		return 1;
	}
	setenv("KANDELO_WORK", session, 1);
	rc = posix_spawnp(&pid, argv[0], NULL, NULL, argv, environ);
	if (rc != 0) {
		fprintf(stderr, "kandelo-exchange: %s: %s\n", argv[0], strerror(rc));
		return 127;
	}
	while (waitpid(pid, &status, 0) < 0) {
		if (errno != EINTR) return 1;
	}
	close(fd);
	return exit_status_of(status);
}

static int valid_id(const char *id)
{
	if (strlen(id) != 36) return 0;
	for (int i = 0; i < 36; i++) {
		int dash = i == 8 || i == 13 || i == 18 || i == 23;
		if (dash ? id[i] != '-' : !strchr("0123456789abcdef", id[i])) return 0;
	}
	return 1;
}

static int cmd_ack(int argc, char **argv)
{
	char dir[128];
	if (argc != 1 || !valid_id(argv[0])) return usage();
	snprintf(dir, sizeof dir, KX_INBOX "/%s", argv[0]);
	if (kx_remove_tree(dir) != 0) {
		fprintf(stderr, "kandelo-exchange: ack %s: %s\n", argv[0], strerror(errno));
		return 1;
	}
	return 0;
}

static int valid_rule_name(const char *name)
{
	if (!*name || strlen(name) > 100 || name[0] == '.') return 0;
	for (const char *p = name; *p; p++)
		if (!(isalnum((unsigned char)*p) || *p == '-' || *p == '_' || *p == '.')) return 0;
	return 1;
}

static void rule_path(char *out, size_t size, const char *name)
{
	snprintf(out, size, KX_RULES_ETC "/%s%s", name, kx_ends_with(name, ".handler") ? "" : ".handler");
}

/* The handler account: the `user NAME` line of exchange.conf, read with
 * kxchgd's rules (programs/kandelo-exchange/kxchgd.c, read_conf) -- comments
 * and blank lines allowed, any other line invalid -- so `handler list`
 * judges rules for the account the agent switches to, and refuses a file
 * the agent would refuse. */
static int read_handler_account(char *user, size_t size)
{
	char line[256];
	int found = 0;
	FILE *file = fopen(KX_CONF, "r");
	if (!file) {
		fprintf(stderr, "kandelo-exchange: cannot read %s: %s\n", KX_CONF, strerror(errno));
		return -1;
	}
	while (fgets(line, sizeof line, file)) {
		char key[32], value[128], extra[2];
		char *hash = strchr(line, '#');
		int n;
		if (hash) *hash = '\0';
		n = sscanf(line, "%31s %127s %1s", key, value, extra);
		if (n <= 0) continue;
		if (n == 2 && strcmp(key, "user") == 0 && !found) {
			snprintf(user, size, "%s", value);
			found = 1;
			continue;
		}
		fprintf(stderr, "kandelo-exchange: %s: invalid line: %s", KX_CONF, line);
		fclose(file);
		return -1;
	}
	fclose(file);
	if (!found) fprintf(stderr, "kandelo-exchange: %s names no user\n", KX_CONF);
	return found ? 0 : -1;
}

static int cmd_list(void)
{
	static struct kx_rules rules;
	char user[128];
	struct passwd *pw;
	uid_t handler_uid;
	if (read_handler_account(user, sizeof user) != 0) return 1;
	pw = getpwnam(user);
	if (!pw) {
		fprintf(stderr, "kandelo-exchange: unknown user %s in %s\n", user, KX_CONF);
		return 1;
	}
	handler_uid = pw->pw_uid;
	/* The agent reads rules after switching to the account, so a rule it
	 * cannot open is ignored as unsafe. Root can do the same and see exactly
	 * what the agent sees; any other caller reads with its own access. This
	 * process only lists, so the switch need not be undone. */
	if (getuid() == 0 && handler_uid != 0) {
		char name[128];
		gid_t gid = pw->pw_gid;
		snprintf(name, sizeof name, "%s", pw->pw_name);
		if (initgroups(name, gid) != 0 || setgid(gid) != 0 || setuid(handler_uid) != 0) {
			fprintf(stderr, "kandelo-exchange: cannot switch to %s: %s\n", name, strerror(errno));
			return 1;
		}
	}
	kx_load_rules(&rules, handler_uid);
	for (int i = 0; i < rules.count; i++) {
		const struct kx_rule *r = &rules.rule[i];
		printf("%-28s %s", r->name, r->dir);
		if (r->masked) printf("  (masked)");
		else if (r->unsafe) printf("  (ignored: unsafe permissions)");
		else if (r->invalid) printf("  (ignored: invalid syntax)");
		else {
			printf("  kind=%s", r->kind == KX_KIND_FILE ? "file" : r->kind == KX_KIND_STREAM ? "stream" : "any");
			for (int m = 0; m < r->match_count; m++)
				printf(" %s=%s", r->match_kind[m] == 'e' ? "extension" : "mime", r->match[m]);
			if (r->max_bytes >= 0) printf(" max-bytes=%lld", r->max_bytes);
			printf("  run");
			for (int a = 0; a < r->argc; a++) printf(" %s", r->args[a]);
		}
		printf("\n");
	}
	return 0;
}

/* Write a rule atomically: a temporary file, then rename. */
static int write_rule(const char *name, const char *text)
{
	char path[512], temp[600];
	int fd;
	rule_path(path, sizeof path, name);
	snprintf(temp, sizeof temp, "%s.tmp.%d", path, (int)getpid());
	fd = open(temp, O_WRONLY | O_CREAT | O_EXCL, 0644);
	if (fd < 0 || kx_write_all(fd, text, strlen(text)) != 0 || close(fd) != 0 || rename(temp, path) != 0) {
		fprintf(stderr, "kandelo-exchange: cannot write %s: %s\n", path, strerror(errno));
		unlink(temp);
		return 1;
	}
	return 0;
}

static int cmd_add(int argc, char **argv)
{
	char text[4096];
	size_t used = 0;
	int have_run = 0;
	if (argc < 1 || !valid_rule_name(argv[0])) return usage();
	/* Stops adding once the rule no longer fits; checked after each option. */
#define APPEND(...) do { if (used < sizeof text) used += (size_t)snprintf(text + used, sizeof text - used, __VA_ARGS__); } while (0)
	APPEND("# Added by kandelo-exchange handler add\n");
	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--extension") == 0 && i + 1 < argc) APPEND("match extension %s\n", argv[++i]);
		else if (strcmp(argv[i], "--mime") == 0 && i + 1 < argc) APPEND("match mime %s\n", argv[++i]);
		else if (strcmp(argv[i], "--kind") == 0 && i + 1 < argc) APPEND("kind %s\n", argv[++i]);
		else if (strcmp(argv[i], "--max-bytes") == 0 && i + 1 < argc) APPEND("max-bytes %s\n", argv[++i]);
		else if (strcmp(argv[i], "--run") == 0 && i + 1 < argc) {
			APPEND("run");
			for (i++; i < argc; i++) APPEND(" %s", argv[i]);
			APPEND("\n");
			have_run = 1;
		} else {
			return usage();
		}
		if (used >= sizeof text) {
			fprintf(stderr, "kandelo-exchange: rule too long\n");
			return 1;
		}
	}
#undef APPEND
	if (!have_run) return usage();
	return write_rule(argv[0], text);
}

static int cmd_handler(int argc, char **argv)
{
	char path[512];
	if (argc < 1) return usage();
	if (strcmp(argv[0], "list") == 0 && argc == 1) return cmd_list();
	if (strcmp(argv[0], "add") == 0) return cmd_add(argc - 1, argv + 1);
	if (argc != 2 || !valid_rule_name(argv[1])) return usage();
	if (strcmp(argv[0], "remove") == 0) {
		rule_path(path, sizeof path, argv[1]);
		if (unlink(path) != 0) {
			fprintf(stderr, "kandelo-exchange: remove %s: %s\n", path, strerror(errno));
			return 1;
		}
		return 0;
	}
	if (strcmp(argv[0], "mask") == 0) return write_rule(argv[1], "");
	return usage();
}

int main(int argc, char **argv)
{
	if (argc > 1 && strcmp(argv[1], "--help") == 0) {
		fputs(help_text, stdout);
		return 0;
	}
	if (argc > 1 && strcmp(argv[1], "--version") == 0) {
		fputs("kandelo-exchange (Kandelo kandelo-exchange) 0.1.0\n", stdout);
		return 0;
	}
	if (argc < 2) return usage();
	if (strcmp(argv[1], "run") == 0) return cmd_run(argc - 2, argv + 2);
	if (strcmp(argv[1], "ack") == 0) return cmd_ack(argc - 2, argv + 2);
	if (strcmp(argv[1], "handler") == 0) return cmd_handler(argc - 2, argv + 2);
	return usage();
}
