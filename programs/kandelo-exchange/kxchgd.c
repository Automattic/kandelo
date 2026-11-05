/* kxchgd: the Kandelo exchange agent.
 *
 * Installed at /usr/libexec/kandelo/exchange-agent, where the kernel starts
 * it on demand as root (see docs/architecture.md, "Kandelo exchange"). It:
 *
 *   1. reads `user NAME` from /etc/kandelo/exchange.conf and switches to
 *      that account (initgroups, setgid, setuid), checking it cannot regain
 *      root and that the account is in the exchange group;
 *   2. opens /run/kandelo/exchange/events, becoming the consumer. It does
 *      so after switching because the kernel gives batches to the
 *      consumer's credentials as of that open: the handler account must
 *      own them to remove them and set their status;
 *   3. for each batch, re-reads the handler rules, runs the first rule that
 *      matches every top-level entry in a fresh work session, records the
 *      outcome as the batch status, and removes the batch;
 *   4. exits after 60 s with no batch in flight.
 *
 * Exit statuses: 0 idle exit, 75 another consumer holds events, 78
 * (EX_CONFIG) a missing or invalid configuration. Logs to
 * /var/log/kxchgd.log and stderr. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <kandelo/exchange.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <time.h>
#include <unistd.h>

#include "kx-rules.h"
#include "kx-util.h"

#define CONF_PATH "/etc/kandelo/exchange.conf"
#define LOG_PATH "/var/log/kxchgd.log"
#define EX_TEMPFAIL 75
/* The kernel's limit on entries in one batch. */
#define MAX_ENTRIES 1024
#define EX_CONFIG 78

extern char **environ;

static int log_fd = -1;

static void say(const char *format, ...)
{
	char line[1024];
	va_list args;
	int n = snprintf(line, sizeof line, "kxchgd[%d]: ", (int)getpid());
	va_start(args, format);
	n += vsnprintf(line + n, sizeof line - (size_t)n, format, args);
	va_end(args);
	if (n >= (int)sizeof line - 1) n = (int)sizeof line - 2;
	line[n++] = '\n';
	if (log_fd >= 0) kx_write_all(log_fd, line, (size_t)n);
	kx_write_all(STDERR_FILENO, line, (size_t)n);
}

/* `user NAME` from exchange.conf; comments and blank lines are allowed. */
static int read_conf(char *user, size_t size)
{
	char line[256];
	int found = 0;
	FILE *file = fopen(CONF_PATH, "r");
	if (!file) {
		say("cannot read %s: %s", CONF_PATH, strerror(errno));
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
		say("%s: invalid line: %s", CONF_PATH, line);
		fclose(file);
		return -1;
	}
	fclose(file);
	if (!found) say("%s names no user", CONF_PATH);
	return found ? 0 : -1;
}

/* Become `user`; `user root` is honored only when written explicitly. */
static int drop_privileges(const char *user, uid_t *uid_out)
{
	/* Copy what we need: getpwnam's result is a static buffer that later
	 * lookups (initgroups reads the group database) may reuse. */
	struct passwd *pw = getpwnam(user);
	char name[128], home[256];
	uid_t uid;
	gid_t gid, groups[64];
	int count, member = 0;
	if (!pw) {
		say("unknown user %s in %s", user, CONF_PATH);
		return -1;
	}
	snprintf(name, sizeof name, "%s", pw->pw_name);
	snprintf(home, sizeof home, "%s", pw->pw_dir);
	uid = pw->pw_uid;
	gid = pw->pw_gid;
	*uid_out = uid;
	if (uid != 0) {
		if (initgroups(name, gid) != 0 || setgid(gid) != 0 || setuid(uid) != 0) {
			say("cannot switch to %s: %s", name, strerror(errno));
			return -1;
		}
		if (setuid(0) == 0 || errno != EPERM) {
			say("could regain root after switching to %s; refusing to run", name);
			return -1;
		}
	}
	count = getgroups(64, groups);
	for (int i = 0; i < count; i++)
		if (groups[i] == KX_GID) member = 1;
	if (getgid() == KX_GID) member = 1;
	if (!member && uid != 0) {
		char list[256] = "";
		size_t used = 0;
		for (int i = 0; i < count && used < sizeof list - 12; i++)
			used += (size_t)snprintf(list + used, sizeof list - used, " %d", (int)groups[i]);
		say("%s is not in the exchange group (%d); handlers could not open work sessions (groups:%s)",
		    name, KX_GID, count < 0 ? " unknown" : list);
		return -1;
	}
	setenv("HOME", home, 1);
	setenv("USER", name, 1);
	setenv("LOGNAME", name, 1);
	return 0;
}

static int read_line(int fd, char *line, size_t size)
{
	size_t used = 0;
	while (used + 1 < size) {
		ssize_t n = read(fd, line + used, 1);
		if (n < 0) {
			if (errno == EINTR) continue;
			return -1;
		}
		if (n == 0) break;
		if (line[used++] == '\n') break;
	}
	line[used] = '\0';
	return (int)used;
}

static int list_entries(const char *dir, struct kx_entry *entries, int max)
{
	DIR *listing = opendir(dir);
	struct dirent *d;
	int count = 0;
	if (!listing) return -1;
	while ((d = readdir(listing)) && count < max) {
		char path[1024];
		struct stat st;
		struct kx_entry *e;
		ssize_t n;
		if (strcmp(d->d_name, ".") == 0 || strcmp(d->d_name, "..") == 0) continue;
		snprintf(path, sizeof path, "%s/%s", dir, d->d_name);
		if (lstat(path, &st) != 0) continue;
		e = &entries[count++];
		memset(e, 0, sizeof *e);
		snprintf(e->name, sizeof e->name, "%s", d->d_name);
		e->is_regular = S_ISREG(st.st_mode);
		e->is_fifo = S_ISFIFO(st.st_mode);
		e->is_dir = S_ISDIR(st.st_mode);
		e->size = st.st_size;
		n = getxattr(path, KX_XATTR_MIME_TYPE, e->mime, sizeof e->mime - 1);
		if (n > 0) e->mime[n] = '\0';
	}
	closedir(listing);
	return count;
}

/* A status is one line of at most 256 bytes of UTF-8 (the kernel refuses
 * more): cut a long one at a character boundary, and lines at the first. */
static void set_status(const char *dir, const char *status)
{
	size_t length = strcspn(status, "\n\r");
	if (length > 256) {
		length = 256;
		while (length > 0 && ((unsigned char)status[length] & 0xC0) == 0x80) length--;
	}
	if (setxattr(dir, KX_XATTR_STATUS, status, length, 0) != 0)
		say("cannot set the status of %s: %s", dir, strerror(errno));
}

/* Run `rule` for the batch; returns the wait status, or -1. */
static int run_handler(const struct kx_rule *rule, const char *dir, const char *id)
{
	char session[256], env_batch[1100], env_id[80], env_work[300];
	char *argv[KX_MAX_ARGS + 2];
	char **envp;
	size_t env_count = 0, i;
	posix_spawn_file_actions_t actions;
	pid_t pid;
	int status = -1, session_fd, rc;

	session_fd = kx_session_open(session, sizeof session);
	if (session_fd < 0) {
		say("cannot open a work session: %s", strerror(errno));
		return -1;
	}
	argv[0] = (char *)rule->args[0];
	argv[1] = (char *)dir;
	for (int a = 1; a < rule->argc; a++) argv[a + 1] = (char *)rule->args[a];
	argv[rule->argc + 1] = NULL;

	snprintf(env_batch, sizeof env_batch, "KANDELO_EXCHANGE_BATCH=%s", dir);
	snprintf(env_id, sizeof env_id, "KANDELO_EXCHANGE_BATCH_ID=%s", id);
	snprintf(env_work, sizeof env_work, "KANDELO_WORK=%s", session);
	while (environ[env_count]) env_count++;
	envp = calloc(env_count + 4, sizeof *envp);
	if (!envp) {
		close(session_fd);
		return -1;
	}
	for (i = 0; i < env_count; i++) envp[i] = environ[i];
	envp[i++] = env_batch;
	envp[i++] = env_id;
	envp[i++] = env_work;
	envp[i] = NULL;

	posix_spawn_file_actions_init(&actions);
	posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
	posix_spawn_file_actions_addchdir_np(&actions, session);
	rc = argv[0][0] == '/'
		? posix_spawn(&pid, argv[0], &actions, NULL, argv, envp)
		: posix_spawnp(&pid, argv[0], &actions, NULL, argv, envp);
	posix_spawn_file_actions_destroy(&actions);
	free(envp);
	if (rc != 0) {
		say("cannot run %s for %s: %s", argv[0], rule->name, strerror(rc));
		close(session_fd);
		return -1;
	}
	while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
	}
	/* Closing the session removes whatever the handler left unpublished. */
	close(session_fd);
	return status;
}

static void process_batch(const char *id, uid_t handler_uid)
{
	char dir[512], status[300];
	struct kx_entry *entries = calloc(MAX_ENTRIES, sizeof *entries);
	struct kx_rules *rules;
	const struct kx_rule *chosen = NULL;
	int count;

	if (!entries) return;
	snprintf(dir, sizeof dir, KX_INBOX "/%s", id);
	count = list_entries(dir, entries, MAX_ENTRIES);
	if (count < 0) {
		say("cannot read batch %s: %s", id, strerror(errno));
		free(entries);
		return;
	}
	rules = calloc(1, sizeof *rules);
	if (!rules) {
		free(entries);
		return;
	}
	kx_load_rules(rules, handler_uid);
	for (int r = 0; r < rules->count; r++) {
		const struct kx_rule *rule = &rules->rule[r];
		int all = count > 0;
		if (rule->unsafe) {
			say("ignored rule %s: unsafe permissions", rule->name);
			continue;
		}
		if (rule->invalid) {
			say("ignored rule %s: invalid syntax", rule->name);
			continue;
		}
		for (int e = 0; e < count && all; e++)
			if (!kx_rule_matches(rule, &entries[e])) all = 0;
		if (all) {
			chosen = rule;
			break;
		}
	}

	if (!chosen) {
		snprintf(status, sizeof status, "no handler: %s", count > 0 ? entries[0].name : "(empty batch)");
		for (int e = 0; e < count; e++) {
			int matched = 0;
			for (int r = 0; r < rules->count && !matched; r++)
				matched = kx_rule_matches(&rules->rule[r], &entries[e]);
			if (!matched) {
				snprintf(status, sizeof status, "no handler: %s", entries[e].name);
				break;
			}
		}
		set_status(dir, status);
	} else {
		char before[300] = "", after[300] = "";
		ssize_t n;
		int wait_status;
		n = getxattr(dir, KX_XATTR_STATUS, before, sizeof before - 1);
		if (n > 0) before[n] = '\0';
		say("batch %s: %s", id, chosen->name);
		wait_status = run_handler(chosen, dir, id);
		n = getxattr(dir, KX_XATTR_STATUS, after, sizeof after - 1);
		if (n > 0) after[n] = '\0';
		else after[0] = '\0';
		int handler_set = after[0] && strcmp(after, before) != 0;
		if (wait_status == -1) {
			set_status(dir, "failed: could not run the handler");
		} else if (WIFEXITED(wait_status) && WEXITSTATUS(wait_status) == 0) {
			if (!handler_set) set_status(dir, "done");
		} else if (!handler_set || strncmp(after, "failed", 6) != 0) {
			if (WIFSIGNALED(wait_status))
				snprintf(status, sizeof status, "failed: signal %d", WTERMSIG(wait_status));
			else
				snprintf(status, sizeof status, "failed: exit %d", WEXITSTATUS(wait_status));
			set_status(dir, status);
		}
	}
	free(rules);
	free(entries);
	/* Removing the batch settles it on the host. */
	if (kx_remove_tree(dir) != 0) say("cannot remove batch %s: %s", id, strerror(errno));
}

int main(int argc, char **argv)
{
	int idle_seconds = 60;
	char user[128], line[128];
	uid_t handler_uid = 0;
	int events;

	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--foreground") == 0) continue; /* it never daemonizes */
		if (strcmp(argv[i], "--idle-timeout") == 0 && i + 1 < argc) {
			idle_seconds = atoi(argv[++i]);
			continue;
		}
		fprintf(stderr, "usage: %s [--foreground] [--idle-timeout SECONDS]\n", argv[0]);
		return 64;
	}
	log_fd = open(LOG_PATH, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0640);

	if (read_conf(user, sizeof user) != 0 || drop_privileges(user, &handler_uid) != 0) return EX_CONFIG;
	events = open(KX_EVENTS, O_RDONLY | O_CLOEXEC);
	if (events < 0) {
		int saved = errno;
		say("cannot open %s: %s", KX_EVENTS, strerror(saved));
		return saved == EBUSY ? EX_TEMPFAIL : 1;
	}
	say("ready as %s", user);

	for (;;) {
		struct pollfd pfd = {.fd = events, .events = POLLIN};
		int ready = poll(&pfd, 1, idle_seconds * 1000);
		if (ready < 0) {
			if (errno == EINTR) continue;
			say("poll: %s", strerror(errno));
			return 1;
		}
		if (ready == 0) {
			say("idle for %d s; exiting", idle_seconds);
			return 0;
		}
		if (read_line(events, line, sizeof line) <= 0) {
			say("events closed");
			return 1;
		}
		if (strncmp(line, "batch ", 6) == 0) {
			line[strcspn(line, "\n")] = '\0';
			process_batch(line + 6, handler_uid);
		}
		/* `outputs accepting|none` lines need no action here. */
	}
}
