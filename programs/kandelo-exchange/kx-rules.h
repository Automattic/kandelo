/* Handler rules for Kandelo exchange, shared by kxchgd and
 * `kandelo-exchange handler`.
 *
 * One rule per file, `*.handler`, in two directories merged by file name,
 * highest precedence first:
 *
 *   /etc/kandelo/exchange-handlers.d/        the image's and runtime rules
 *   /usr/share/kandelo/exchange-handlers.d/  vendor defaults
 *
 * A file in /etc replaces the same name in /usr/share; an empty one masks it.
 * Rules are tried in lexical file-name order. Lines:
 *
 *   match extension .wad     (any `match` line may match; none = everything)
 *   match mime image/png     (`image/` + `*` matches the whole type)
 *   kind file|stream|any     (default file)
 *   max-bytes N              (regular files only)
 *   run PROGRAM [ARGS...]    (the batch directory is argv[1], ARGS follow)
 *
 * A rule file runs code as the handler account, so only root or that account
 * may own it, and no one else may write it. */
#ifndef KX_RULES_H
#define KX_RULES_H

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#define KX_RULES_ETC "/etc/kandelo/exchange-handlers.d"
#define KX_RULES_VENDOR "/usr/share/kandelo/exchange-handlers.d"
#define KX_MAX_RULES 64
#define KX_MAX_MATCHES 16
#define KX_MAX_ARGS 16

enum kx_kind { KX_KIND_FILE, KX_KIND_STREAM, KX_KIND_ANY };

struct kx_rule {
	char name[128];      /* file name, e.g. 99-save.handler */
	const char *dir;     /* where it came from */
	int masked;          /* an empty file in /etc */
	int unsafe;          /* refused: ownership or permissions */
	int invalid;         /* refused: syntax */
	enum kx_kind kind;
	long long max_bytes; /* -1: none */
	int match_count;
	char match_kind[KX_MAX_MATCHES]; /* 'e' extension, 'm' mime */
	char match[KX_MAX_MATCHES][128];
	int argc;
	char args[KX_MAX_ARGS][256];
};

struct kx_rules {
	int count;
	struct kx_rule rule[KX_MAX_RULES];
};

static inline int kx_rule_cmp(const void *a, const void *b)
{
	return strcmp(((const struct kx_rule *)a)->name, ((const struct kx_rule *)b)->name);
}

static inline int kx_ends_with(const char *s, const char *suffix)
{
	size_t n = strlen(s), m = strlen(suffix);
	return n >= m && strcmp(s + n - m, suffix) == 0;
}

/* Parse one rule file into `rule`; an empty file is a mask. */
static inline void kx_parse_rule(struct kx_rule *rule, FILE *file)
{
	char line[512];
	int lines = 0;
	rule->kind = KX_KIND_FILE;
	rule->max_bytes = -1;
	while (fgets(line, sizeof line, file)) {
		char *words[KX_MAX_ARGS + 2];
		int count = 0;
		char *save = NULL;
		char *hash = strchr(line, '#');
		if (hash) *hash = '\0';
		for (char *w = strtok_r(line, " \t\r\n", &save); w && count < KX_MAX_ARGS + 2;
		     w = strtok_r(NULL, " \t\r\n", &save))
			words[count++] = w;
		if (count == 0) continue;
		lines++;
		if (strcmp(words[0], "match") == 0 && count == 3 && rule->match_count < KX_MAX_MATCHES) {
			if (strcmp(words[1], "extension") == 0) rule->match_kind[rule->match_count] = 'e';
			else if (strcmp(words[1], "mime") == 0) rule->match_kind[rule->match_count] = 'm';
			else { rule->invalid = 1; continue; }
			snprintf(rule->match[rule->match_count++], sizeof rule->match[0], "%s", words[2]);
		} else if (strcmp(words[0], "kind") == 0 && count == 2) {
			if (strcmp(words[1], "file") == 0) rule->kind = KX_KIND_FILE;
			else if (strcmp(words[1], "stream") == 0) rule->kind = KX_KIND_STREAM;
			else if (strcmp(words[1], "any") == 0) rule->kind = KX_KIND_ANY;
			else rule->invalid = 1;
		} else if (strcmp(words[0], "max-bytes") == 0 && count == 2) {
			char *end;
			rule->max_bytes = strtoll(words[1], &end, 10);
			if (*end || rule->max_bytes < 0) rule->invalid = 1;
		} else if (strcmp(words[0], "run") == 0 && count >= 2) {
			rule->argc = 0;
			for (int i = 1; i < count && rule->argc < KX_MAX_ARGS; i++)
				snprintf(rule->args[rule->argc++], sizeof rule->args[0], "%s", words[i]);
		} else {
			rule->invalid = 1;
		}
	}
	if (lines == 0) rule->masked = 1;
	else if (rule->argc == 0) rule->invalid = 1;
}

/* Merge both directories. `handler_uid` is the account rules run as. */
static inline void kx_load_rules(struct kx_rules *rules, uid_t handler_uid)
{
	const char *dirs[2] = {KX_RULES_ETC, KX_RULES_VENDOR};
	rules->count = 0;
	for (int d = 0; d < 2; d++) {
		DIR *dir = opendir(dirs[d]);
		struct dirent *entry;
		if (!dir) continue;
		while ((entry = readdir(dir)) && rules->count < KX_MAX_RULES) {
			char path[512];
			struct stat st;
			struct kx_rule *rule;
			int seen = 0;
			FILE *file;
			if (entry->d_name[0] == '.' || !kx_ends_with(entry->d_name, ".handler")) continue;
			for (int i = 0; i < rules->count; i++)
				if (strcmp(rules->rule[i].name, entry->d_name) == 0) seen = 1;
			if (seen) continue; /* /etc already provided this name */
			rule = &rules->rule[rules->count++];
			memset(rule, 0, sizeof *rule);
			snprintf(rule->name, sizeof rule->name, "%s", entry->d_name);
			rule->dir = dirs[d];
			snprintf(path, sizeof path, "%s/%s", dirs[d], entry->d_name);
			if (lstat(path, &st) != 0 || !S_ISREG(st.st_mode)) {
				rule->unsafe = 1;
				continue;
			}
			if ((st.st_uid != 0 && st.st_uid != handler_uid) || (st.st_mode & 022)) {
				rule->unsafe = 1;
				continue;
			}
			file = fopen(path, "r");
			if (!file) {
				rule->unsafe = 1;
				continue;
			}
			kx_parse_rule(rule, file);
			fclose(file);
		}
		closedir(dir);
	}
	qsort(rules->rule, rules->count, sizeof rules->rule[0], kx_rule_cmp);
}

/* One top-level entry of a batch. */
struct kx_entry {
	char name[256];
	char mime[128];
	int is_regular, is_fifo, is_dir;
	long long size;
};

static inline int kx_rule_matches(const struct kx_rule *rule, const struct kx_entry *entry)
{
	if (rule->masked || rule->unsafe || rule->invalid) return 0;
	switch (rule->kind) {
	case KX_KIND_FILE: if (!entry->is_regular) return 0; break;
	case KX_KIND_STREAM: if (!entry->is_fifo) return 0; break;
	case KX_KIND_ANY: break;
	}
	if (rule->max_bytes >= 0 && entry->is_regular && entry->size > rule->max_bytes) return 0;
	if (rule->match_count == 0) return 1;
	for (int i = 0; i < rule->match_count; i++) {
		const char *want = rule->match[i];
		if (rule->match_kind[i] == 'e') {
			size_t n = strlen(entry->name), m = strlen(want);
			if (n > m && strcasecmp(entry->name + n - m, want) == 0) return 1;
		} else {
			size_t m = strlen(want);
			if (m >= 2 && strcmp(want + m - 2, "/*") == 0) {
				if (strncasecmp(entry->mime, want, m - 1) == 0) return 1;
			} else if (strcasecmp(entry->mime, want) == 0) {
				return 1;
			}
		}
	}
	return 0;
}

#endif
