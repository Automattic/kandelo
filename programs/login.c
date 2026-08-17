#define _GNU_SOURCE
#include <crypt.h>
#include <grp.h>
#include <pwd.h>
#include <shadow.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

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

static int read_field(const char *prompt, char *buf, size_t buflen, int hide) {
    struct termios old_term;
    struct termios new_term;
    int fd = fileno(stdin);
    int restore_echo = 0;

    fputs(prompt, stdout);
    fflush(stdout);
    if (hide && isatty(fd)) {
        if (tcgetattr(fd, &old_term) != 0) {
            perror("login: tcgetattr");
            return -1;
        }
        new_term = old_term;
        new_term.c_lflag &= (tcflag_t)~ECHO;
        if (tcsetattr(fd, TCSAFLUSH, &new_term) != 0) {
            perror("login: tcsetattr");
            return -1;
        }
        restore_echo = 1;
    }
    if (!fgets(buf, buflen, stdin)) {
        if (restore_echo) {
            tcsetattr(fd, TCSAFLUSH, &old_term);
            fputc('\n', stdout);
        }
        return -1;
    }
    if (restore_echo) {
        if (tcsetattr(fd, TCSAFLUSH, &old_term) != 0) {
            perror("login: tcsetattr");
            return -1;
        }
        fputc('\n', stdout);
    }
    chomp(buf);
    return 0;
}

static int hash_is_locked(const char *hash) {
    return !hash || hash[0] == '\0' || hash[0] == '!' || hash[0] == '*';
}

static int authenticate(const char *username, const char *password,
                        struct passwd **out_pw) {
    struct passwd *pw = getpwnam(username);
    if (!pw) return -1;
    struct spwd *sp = getspnam(username);
    const char *hash = sp && sp->sp_pwdp ? sp->sp_pwdp : pw->pw_passwd;
    if (hash_is_locked(hash) || strcmp(hash, "x") == 0) return -1;
    char *computed = crypt(password, hash);
    if (!computed || !secure_streq(computed, hash)) return -1;
    *out_pw = pw;
    return 0;
}

static int copy_value(char *out, size_t out_size, const char *value) {
    int written = snprintf(out, out_size, "%s", value);
    return written >= 0 && (size_t)written < out_size ? 0 : -1;
}

static int set_login_environment(const struct passwd *pw,
                                 int preserve_environment) {
    const char *term = getenv("TERM");
    char term_buf[128];
    if (term && copy_value(term_buf, sizeof(term_buf), term) != 0) return -1;
    if (!preserve_environment && clearenv() != 0) return -1;
    if (setenv("HOME", pw->pw_dir, 1) != 0)
        return -1;
    if (setenv("SHELL", pw->pw_shell && pw->pw_shell[0]
                         ? pw->pw_shell : "/bin/sh", 1) != 0)
        return -1;
    if (setenv("USER", pw->pw_name, 1) != 0) return -1;
    if (setenv("LOGNAME", pw->pw_name, 1) != 0) return -1;
    if ((!preserve_environment || !getenv("PATH")) &&
        setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1) != 0)
        return -1;
    if (!preserve_environment && term && setenv("TERM", term_buf, 1) != 0)
        return -1;
    return 0;
}

static void display_file(const char *path) {
    FILE *file = fopen(path, "r");
    if (!file) return;
    char buf[512];
    size_t nread;
    while ((nread = fread(buf, 1, sizeof(buf), file)) > 0) {
        if (fwrite(buf, 1, nread, stdout) != nread) break;
    }
    fclose(file);
}

static char *login_shell_argv0(const char *shell) {
    const char *base = strrchr(shell, '/');
    base = base ? base + 1 : shell;
    if (!base[0]) base = "sh";
    size_t len = strlen(base);
    char *argv0 = malloc(len + 2);
    if (!argv0) return NULL;
    argv0[0] = '-';
    memcpy(argv0 + 1, base, len + 1);
    return argv0;
}

static void usage(const char *argv0) {
    fprintf(stderr, "usage: %s [-p] [-f username] [username]\n", argv0);
}

int main(int argc, char **argv) {
    char username[128];
    char password[512] = {0};
    const char *requested_user = NULL;
    struct passwd *pw = NULL;
    int preauthenticated = 0;
    int preserve_environment = 0;
    int opt;

    while ((opt = getopt(argc, argv, "f:p")) != -1) {
        switch (opt) {
            case 'f': requested_user = optarg; preauthenticated = 1; break;
            case 'p': preserve_environment = 1; break;
            default: usage(argv[0]); return 2;
        }
    }
    if (argc - optind > 1 || (requested_user && optind < argc)) {
        usage(argv[0]);
        return 2;
    }
    if (!requested_user && optind < argc) requested_user = argv[optind];

    /* Effective uid is root for every set-ID invocation; only real uid 0
       authorizes a terminal manager's preauthentication or environment. */
    if ((preauthenticated || preserve_environment) && getuid() != 0) {
        fputs("login: -f and -p require a root caller\n", stderr);
        return 1;
    }

    if (requested_user) {
        if (copy_value(username, sizeof(username), requested_user) != 0)
            return 1;
    } else if (read_field("login: ", username, sizeof(username), 0) != 0) {
        return 1;
    }
    if (username[0] == '\0') return 1;

    if (preauthenticated) {
        pw = getpwnam(username);
        if (!pw) {
            sleep(1);
            fputs("Login incorrect\n", stderr);
            return 1;
        }
    } else {
        if (read_field("Password: ", password, sizeof(password), 1) != 0) {
            scrub(password);
            return 1;
        }
        if (authenticate(username, password, &pw) != 0) {
            scrub(password);
            sleep(1);
            fputs("Login incorrect\n", stderr);
            return 1;
        }
        scrub(password);
    }

    if (!pw->pw_dir || !pw->pw_dir[0]) {
        fputs("login: account has no home directory\n", stderr);
        return 1;
    }

    /* Dropping uid first would make the remaining group transitions fail. */
    if (initgroups(pw->pw_name, pw->pw_gid) != 0) {
        perror("login: initgroups");
        return 1;
    }
    if (setgid(pw->pw_gid) != 0) {
        perror("login: setgid");
        return 1;
    }
    if (setuid(pw->pw_uid) != 0) {
        perror("login: setuid");
        return 1;
    }
    if (set_login_environment(pw, preserve_environment) != 0) {
        perror("login: environment");
        return 1;
    }

    if (chdir(pw->pw_dir) != 0) {
        perror("login: chdir");
        return 1;
    }
    display_file("/etc/motd");
    if (preauthenticated) display_file("/etc/motd.autologin");

    const char *shell = pw->pw_shell && pw->pw_shell[0]
        ? pw->pw_shell : "/bin/sh";
    char *argv0 = login_shell_argv0(shell);
    if (!argv0) {
        perror("login: malloc");
        return 1;
    }
    char *shell_argv[] = {argv0, NULL};
    fflush(NULL);
    execv(shell, shell_argv);
    perror("login: exec");
    return 1;
}
