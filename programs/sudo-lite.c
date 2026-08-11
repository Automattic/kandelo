#define _GNU_SOURCE
#include <crypt.h>
#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <shadow.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#define AUTHORIZATION_GROUP "wheel"
#define SAFE_PATH "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
#define SUDOERS_PATH "/etc/sudoers"

static void scrub(char *s) {
    if (!s) return;
    volatile char *p = s;
    while (*p) *p++ = '\0';
}

static int secure_streq(const char *a, const char *b) {
    size_t alen = strlen(a);
    size_t blen = strlen(b);
    size_t max = alen > blen ? alen : blen;
    size_t diff = alen ^ blen;
    for (size_t i = 0; i < max; i++) {
        unsigned char ac = i < alen ? (unsigned char)a[i] : 0;
        unsigned char bc = i < blen ? (unsigned char)b[i] : 0;
        diff |= (size_t)(ac ^ bc);
    }
    return diff == 0;
}

static void chomp(char *s) {
    size_t len = strlen(s);
    while (len > 0 && (s[len - 1] == '\n' || s[len - 1] == '\r'))
        s[--len] = '\0';
}

static int read_password(const char *username, char *buf, size_t buflen) {
    struct termios old_term;
    struct termios new_term;
    int fd = fileno(stdin);
    int restore_echo = 0;

    fprintf(stderr, "[sudo-lite] password for %s: ", username);
    fflush(stderr);
    if (isatty(fd)) {
        if (tcgetattr(fd, &old_term) != 0) {
            perror("sudo-lite: tcgetattr");
            return -1;
        }
        new_term = old_term;
        new_term.c_lflag &= (tcflag_t)~ECHO;
        if (tcsetattr(fd, TCSAFLUSH, &new_term) != 0) {
            perror("sudo-lite: tcsetattr");
            return -1;
        }
        restore_echo = 1;
    }
    if (!fgets(buf, buflen, stdin)) {
        if (restore_echo) {
            tcsetattr(fd, TCSAFLUSH, &old_term);
            fputc('\n', stderr);
        }
        return -1;
    }
    if (restore_echo) {
        if (tcsetattr(fd, TCSAFLUSH, &old_term) != 0) {
            perror("sudo-lite: tcsetattr");
            return -1;
        }
        fputc('\n', stderr);
    }
    chomp(buf);
    return 0;
}

static int hash_is_locked(const char *hash) {
    return !hash || hash[0] == '\0' || hash[0] == '!' || hash[0] == '*';
}

static int caller_is_authorized(void) {
    struct group *wheel = getgrnam(AUTHORIZATION_GROUP);
    if (!wheel) return 0;
    gid_t wheel_gid = wheel->gr_gid;
    if (getgid() == wheel_gid || getegid() == wheel_gid) return 1;

    int count = getgroups(0, NULL);
    if (count <= 0) return count;
    gid_t *groups = calloc((size_t)count, sizeof(*groups));
    if (!groups) return -1;
    int actual = getgroups(count, groups);
    if (actual < 0) {
        int groups_errno = errno;
        free(groups);
        errno = groups_errno;
        return -1;
    }
    int authorized = 0;
    for (int i = 0; i < actual; i++) {
        if (groups[i] == wheel_gid) {
            authorized = 1;
            break;
        }
    }
    free(groups);
    return authorized;
}

static int authenticate_caller(uid_t caller_uid, char *username,
                               size_t username_size) {
    char passwd_hash[1024];
    char password[512] = {0};
    struct passwd *pw = getpwuid(caller_uid);
    if (!pw || !pw->pw_name || pw->pw_name[0] == '\0') return -1;
    int username_len = snprintf(username, username_size, "%s", pw->pw_name);
    if (username_len < 0 || (size_t)username_len >= username_size) return -1;
    int hash_len = snprintf(passwd_hash, sizeof(passwd_hash), "%s",
                            pw->pw_passwd ? pw->pw_passwd : "");
    if (hash_len < 0 || (size_t)hash_len >= sizeof(passwd_hash)) return -1;

    struct spwd *sp = getspnam(username);
    const char *hash = sp && sp->sp_pwdp ? sp->sp_pwdp : passwd_hash;
    if (hash_is_locked(hash) || strcmp(hash, "x") == 0) return -1;
    if (read_password(username, password, sizeof(password)) != 0) {
        scrub(password);
        return -1;
    }
    char *computed = crypt(password, hash);
    int accepted = computed && secure_streq(computed, hash);
    scrub(password);
    return accepted ? 0 : -1;
}

/* Unknown sudoers syntax fails closed instead of being silently ignored. */
static int sudoers_allows_wheel(void) {
    FILE *file = fopen(SUDOERS_PATH, "r");
    if (!file) return -2;
    char line[512];
    int allows_wheel = 0;
    while (fgets(line, sizeof(line), file)) {
        if (!strchr(line, '\n') && !feof(file)) {
            fclose(file);
            return -1;
        }
        chomp(line);
        char *cursor = line;
        while (*cursor == ' ' || *cursor == '\t') cursor++;
        char *comment = strchr(cursor, '#');
        if (comment) *comment = '\0';
        char *end = cursor + strlen(cursor);
        while (end > cursor && (end[-1] == ' ' || end[-1] == '\t'))
            *--end = '\0';
        if (*cursor == '\0') continue;

        char subject[128];
        char runas[128];
        char command[128];
        char extra;
        int fields = sscanf(cursor, "%127s %127s %127s %c",
                            subject, runas, command, &extra);
        if (fields != 3 || strcmp(runas, "ALL=(ALL:ALL)") != 0 ||
            strcmp(command, "ALL") != 0 ||
            (strcmp(subject, "root") != 0 &&
             strcmp(subject, "%" AUTHORIZATION_GROUP) != 0)) {
            fclose(file);
            return -1;
        }
        if (strcmp(subject, "%" AUTHORIZATION_GROUP) == 0)
            allows_wheel = 1;
    }
    int read_error = ferror(file);
    fclose(file);
    return read_error ? -2 : allows_wheel;
}

static int become_root(void) {
    /* Supplementary groups must be replaced before root uid is committed. */
    if (initgroups("root", 0) != 0) return -1;
    if (setresgid(0, 0, 0) != 0) return -1;
    if (setresuid(0, 0, 0) != 0) return -1;
    return 0;
}

static int install_root_environment(void) {
    const char *term = getenv("TERM");
    char term_buf[128];
    if (term) {
        int term_len = snprintf(term_buf, sizeof(term_buf), "%s", term);
        if (term_len < 0 || (size_t)term_len >= sizeof(term_buf)) return -1;
    }
    if (clearenv() != 0) return -1;
    if (setenv("HOME", "/root", 1) != 0) return -1;
    if (setenv("USER", "root", 1) != 0) return -1;
    if (setenv("LOGNAME", "root", 1) != 0) return -1;
    if (setenv("SHELL", "/bin/sh", 1) != 0) return -1;
    if (setenv("PATH", SAFE_PATH, 1) != 0) return -1;
    if (term && setenv("TERM", term_buf, 1) != 0) return -1;
    return 0;
}

static void usage(const char *argv0) {
    fprintf(stderr, "usage: %s -l | [--] command [argument ...]\n", argv0);
}

int main(int argc, char **argv) {
    int command_index = 1;
    int list_only = 0;
    if (argc > 1 && strcmp(argv[1], "-l") == 0) {
        if (argc != 2) {
            usage(argv[0]);
            return 2;
        }
        list_only = 1;
    } else if (argc > 1 && strcmp(argv[1], "--") == 0) {
        command_index = 2;
    } else if (argc > 1 && argv[1][0] == '-') {
        fprintf(stderr, "sudo-lite: unsupported option: %s\n", argv[1]);
        usage(argv[0]);
        return 2;
    }
    if (!list_only && command_index >= argc) {
        usage(argv[0]);
        return 2;
    }

    uid_t caller_uid = getuid();
    if (geteuid() != 0) {
        fputs("sudo-lite: effective uid is not root; check setuid mode and mount nosuid policy\n",
              stderr);
        return 1;
    }
    int policy = sudoers_allows_wheel();
    if (policy == -2) {
        perror("sudo-lite: /etc/sudoers");
        return 1;
    }
    if (policy < 0) {
        fputs("sudo-lite: malformed /etc/sudoers\n", stderr);
        return 1;
    }

    char username[128] = "root";
    if (caller_uid != 0) {
        int authorization = caller_is_authorized();
        if (authorization < 0) {
            perror("sudo-lite: authorization");
            return 1;
        }
        if (authorization == 0) {
            fprintf(stderr,
                    "sudo-lite: uid %u is not authorized; current %s membership is required\n",
                    (unsigned)caller_uid, AUTHORIZATION_GROUP);
            return 1;
        }
        if (policy == 0) {
            fputs("sudo-lite: wheel is not allowed by /etc/sudoers\n", stderr);
            return 1;
        }
        if (authenticate_caller(caller_uid, username, sizeof(username)) != 0) {
            sleep(1);
            fputs("sudo-lite: authentication failed\n", stderr);
            return 1;
        }
    }

    if (list_only) {
        printf("User %s may run the following commands on kandelo:\n", username);
        puts("    (ALL:ALL) ALL");
        return 0;
    }
    if (become_root() != 0) {
        perror("sudo-lite: credentials");
        return 1;
    }
    if (install_root_environment() != 0) {
        perror("sudo-lite: environment");
        return 1;
    }

    fflush(NULL);
    execvp(argv[command_index], &argv[command_index]);
    int exec_errno = errno;
    fprintf(stderr, "sudo-lite: exec %s: %s\n", argv[command_index],
            strerror(exec_errno));
    return exec_errno == ENOENT ? 127 : 126;
}
