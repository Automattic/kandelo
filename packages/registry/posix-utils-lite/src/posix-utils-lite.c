#define _POSIX_C_SOURCE 200809L

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

static const char *program_name(const char *path) {
    const char *slash = strrchr(path ? path : "", '/');
    return slash ? slash + 1 : path;
}

static int streq(const char *a, const char *b) {
    return strcmp(a, b) == 0;
}

static int has_suffix(const char *s, const char *suffix) {
    size_t slen = strlen(s);
    size_t tlen = strlen(suffix);
    return slen >= tlen && strcmp(s + slen - tlen, suffix) == 0;
}

static char *xstrndup(const char *s, size_t n) {
    char *out = malloc(n + 1);
    if (!out) {
        perror("malloc");
        exit(2);
    }
    memcpy(out, s, n);
    out[n] = '\0';
    return out;
}

static char *xstrdup(const char *s) {
    return xstrndup(s, strlen(s));
}

static int copy_stream(FILE *in, FILE *out) {
    char buf[8192];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
        if (fwrite(buf, 1, n, out) != n) {
            perror("write");
            return 1;
        }
    }
    if (ferror(in)) {
        perror("read");
        return 1;
    }
    return 0;
}

static int copy_path_to_stream(const char *path, FILE *out) {
    FILE *in = fopen(path, "rb");
    if (!in) {
        perror(path);
        return 1;
    }
    int rc = copy_stream(in, out);
    fclose(in);
    return rc;
}

static int copy_path_to_path(const char *src, const char *dst) {
    FILE *in = fopen(src, "rb");
    if (!in) {
        perror(src);
        return 1;
    }
    FILE *out = fopen(dst, "wb");
    if (!out) {
        perror(dst);
        fclose(in);
        return 1;
    }
    int rc = copy_stream(in, out);
    if (fclose(out) != 0) {
        perror(dst);
        rc = 1;
    }
    fclose(in);
    return rc;
}

static int read_file(const char *path, unsigned char **data, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        perror(path);
        return 1;
    }
    size_t cap = 16384;
    size_t n = 0;
    unsigned char *buf = malloc(cap);
    if (!buf) {
        perror("malloc");
        fclose(f);
        return 1;
    }
    for (;;) {
        if (n == cap) {
            cap *= 2;
            unsigned char *next = realloc(buf, cap);
            if (!next) {
                perror("realloc");
                free(buf);
                fclose(f);
                return 1;
            }
            buf = next;
        }
        size_t got = fread(buf + n, 1, cap - n, f);
        n += got;
        if (got == 0) {
            break;
        }
    }
    if (ferror(f)) {
        perror(path);
        free(buf);
        fclose(f);
        return 1;
    }
    fclose(f);
    *data = buf;
    *len = n;
    return 0;
}

static int write_file(const char *path, const unsigned char *data, size_t len) {
    FILE *f = fopen(path, "wb");
    if (!f) {
        perror(path);
        return 1;
    }
    int rc = fwrite(data, 1, len, f) == len ? 0 : 1;
    if (rc) {
        perror(path);
    }
    if (fclose(f) != 0) {
        perror(path);
        rc = 1;
    }
    return rc;
}

static int util_more(int argc, char **argv) {
    int rc = 0;
    int first = 1;
    while (first < argc && argv[first][0] == '-') {
        first++;
    }
    if (first == argc) {
        return copy_stream(stdin, stdout);
    }
    for (int i = first; i < argc; i++) {
        rc |= copy_path_to_stream(argv[i], stdout);
    }
    return rc;
}

static int util_man(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "man: usage: man topic\n");
        return 1;
    }
    int rc = 0;
    for (int i = 1; i < argc; i++) {
        char path[PATH_MAX];
        int found = 0;
        for (int section = 1; section <= 9; section++) {
            snprintf(path, sizeof(path), "/usr/share/man/man%d/%s.%d", section, argv[i], section);
            if (access(path, R_OK) == 0) {
                found = 1;
                rc |= copy_path_to_stream(path, stdout);
                break;
            }
        }
        if (!found) {
            fprintf(stderr, "man: no entry for %s\n", argv[i]);
            rc = 1;
        }
    }
    return rc;
}

static int util_asa(int argc, char **argv) {
    int rc = 0;
    int start = argc > 1 ? 1 : 0;
    for (int i = start; i < argc; i++) {
        FILE *in = stdin;
        const char *name = "stdin";
        if (argc > 1) {
            name = argv[i];
            in = fopen(name, "r");
            if (!in) {
                perror(name);
                rc = 1;
                continue;
            }
        }
        char *line = NULL;
        size_t cap = 0;
        while (getline(&line, &cap, in) >= 0) {
            char control = line[0] ? line[0] : ' ';
            char *text = line[0] ? line + 1 : line;
            if (control == '0') {
                fputc('\n', stdout);
            } else if (control == '-') {
                fputs("\n\n", stdout);
            } else if (control != '+') {
                /* blank and unknown carriage controls advance one line */
            }
            fputs(text, stdout);
            size_t len = strlen(text);
            if (len == 0 || text[len - 1] != '\n') {
                fputc('\n', stdout);
            }
        }
        free(line);
        if (ferror(in)) {
            perror(name);
            rc = 1;
        }
        if (in != stdin) {
            fclose(in);
        }
    }
    return rc;
}

static int leap_year(int year) {
    return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

static int days_in_month(int month, int year) {
    static const int days[] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    return month == 2 ? days[1] + leap_year(year) : days[month - 1];
}

static int weekday(int year, int month, int day) {
    if (month < 3) {
        month += 12;
        year--;
    }
    int k = year % 100;
    int j = year / 100;
    int h = (day + (13 * (month + 1)) / 5 + k + k / 4 + j / 4 + 5 * j) % 7;
    return (h + 6) % 7;
}

static void print_month(int month, int year) {
    static const char *names[] = {
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    };
    printf("     %s %d\n", names[month - 1], year);
    puts("Su Mo Tu We Th Fr Sa");
    int first = weekday(year, month, 1);
    int days = days_in_month(month, year);
    for (int i = 0; i < first; i++) {
        fputs("   ", stdout);
    }
    for (int day = 1; day <= days; day++) {
        printf("%2d", day);
        if ((first + day) % 7 == 0 || day == days) {
            fputc('\n', stdout);
        } else {
            fputc(' ', stdout);
        }
    }
}

static int util_cal(int argc, char **argv) {
    time_t now = time(NULL);
    struct tm *tm = localtime(&now);
    int month = tm ? tm->tm_mon + 1 : 1;
    int year = tm ? tm->tm_year + 1900 : 1970;
    if (argc == 2) {
        year = atoi(argv[1]);
        if (year < 1) {
            fprintf(stderr, "cal: invalid year: %s\n", argv[1]);
            return 1;
        }
        for (int m = 1; m <= 12; m++) {
            print_month(m, year);
            if (m != 12) {
                fputc('\n', stdout);
            }
        }
        return 0;
    }
    if (argc >= 3) {
        month = atoi(argv[1]);
        year = atoi(argv[2]);
    }
    if (month < 1 || month > 12 || year < 1) {
        fprintf(stderr, "cal: usage: cal [[month] year]\n");
        return 1;
    }
    print_month(month, year);
    return 0;
}

struct conf_entry {
    const char *name;
    int sys_name;
    long fallback;
};

static int util_getconf(int argc, char **argv) {
    static const struct conf_entry entries[] = {
        { "ARG_MAX", _SC_ARG_MAX, 4096 },
        { "CHILD_MAX", _SC_CHILD_MAX, 25 },
        { "CLK_TCK", _SC_CLK_TCK, 100 },
        { "OPEN_MAX", _SC_OPEN_MAX, 256 },
        { "PAGESIZE", _SC_PAGESIZE, 65536 },
        { "PAGE_SIZE", _SC_PAGESIZE, 65536 },
        { "_POSIX_VERSION", _SC_VERSION, 200809L },
        { "POSIX_VERSION", _SC_VERSION, 200809L },
    };
    if (argc < 2) {
        fprintf(stderr, "getconf: usage: getconf name [path]\n");
        return 1;
    }
    if (streq(argv[1], "PATH_MAX") || streq(argv[1], "NAME_MAX") || streq(argv[1], "PIPE_BUF")) {
        const char *path = argc > 2 ? argv[2] : ".";
        int pc_name = streq(argv[1], "NAME_MAX") ? _PC_NAME_MAX : streq(argv[1], "PIPE_BUF") ? _PC_PIPE_BUF : _PC_PATH_MAX;
        errno = 0;
        long value = pathconf(path, pc_name);
        if (value < 0 && errno != 0) {
            perror("getconf");
            return 1;
        }
        printf("%ld\n", value < 0 ? -1L : value);
        return 0;
    }
    for (size_t i = 0; i < sizeof(entries) / sizeof(entries[0]); i++) {
        if (streq(argv[1], entries[i].name)) {
            errno = 0;
            long value = sysconf(entries[i].sys_name);
            if (value < 0 && errno != 0) {
                value = entries[i].fallback;
            }
            printf("%ld\n", value);
            return 0;
        }
    }
    fprintf(stderr, "getconf: unknown variable: %s\n", argv[1]);
    return 2;
}

static int util_locale(int argc, char **argv) {
    if (argc > 1 && streq(argv[1], "-a")) {
        puts("C");
        puts("POSIX");
        puts("C.UTF-8");
        return 0;
    }
    if (argc > 1 && streq(argv[1], "-m")) {
        puts("ASCII");
        puts("UTF-8");
        return 0;
    }
    static const char *vars[] = {
        "LANG", "LC_CTYPE", "LC_COLLATE", "LC_TIME", "LC_NUMERIC",
        "LC_MONETARY", "LC_MESSAGES", "LC_ALL"
    };
    for (size_t i = 0; i < sizeof(vars) / sizeof(vars[0]); i++) {
        const char *value = getenv(vars[i]);
        printf("%s=\"%s\"\n", vars[i], value ? value : "");
    }
    return 0;
}

static int util_logger(int argc, char **argv) {
    const char *tag = program_name(argv[0]);
    int to_stderr = 0;
    int first = 1;
    for (; first < argc; first++) {
        if (streq(argv[first], "-s")) {
            to_stderr = 1;
        } else if ((streq(argv[first], "-t") || streq(argv[first], "-p")) && first + 1 < argc) {
            if (streq(argv[first], "-t")) {
                tag = argv[first + 1];
            }
            first++;
        } else if (argv[first][0] == '-') {
            continue;
        } else {
            break;
        }
    }
    FILE *out = to_stderr ? stderr : stdout;
    fprintf(out, "%s:", tag);
    for (int i = first; i < argc; i++) {
        fprintf(out, " %s", argv[i]);
    }
    fputc('\n', out);
    return 0;
}

struct ps_fields {
    int pid;
    int nice;
    int command;
};

static int ps_pid_selected(long pid, long *pids, int npids) {
    if (npids == 0) {
        return 1;
    }
    for (int i = 0; i < npids; i++) {
        if (pids[i] == pid) {
            return 1;
        }
    }
    return 0;
}

static int ps_add_pid_list(const char *arg, long *pids, int *npids, int max_pids) {
    if (!arg || !*arg) {
        return -1;
    }
    const char *p = arg;
    for (;;) {
        if (*npids >= max_pids) {
            return -1;
        }
        errno = 0;
        char *end = NULL;
        long pid = strtol(p, &end, 10);
        if (errno != 0 || end == p || pid <= 0 || (*end != '\0' && *end != ',')) {
            return -1;
        }
        pids[(*npids)++] = pid;
        if (*end == '\0') {
            return 0;
        }
        p = end + 1;
        if (*p == '\0') {
            return -1;
        }
    }
}

static void ps_parse_fields(const char *arg, struct ps_fields *fields) {
    fields->pid = 0;
    fields->nice = 0;
    fields->command = 0;

    char *copy = xstrdup(arg);
    for (char *tok = strtok(copy, ", "); tok; tok = strtok(NULL, ", ")) {
        if (streq(tok, "pid")) {
            fields->pid = 1;
        } else if (streq(tok, "nice") || streq(tok, "ni")) {
            fields->nice = 1;
        } else if (streq(tok, "comm") || streq(tok, "command") ||
                   streq(tok, "args")) {
            fields->command = 1;
        }
    }
    if (!fields->pid && !fields->nice && !fields->command) {
        fields->pid = 1;
        fields->command = 1;
    }
    free(copy);
}

static int ps_read_stat(long pid, char *comm, size_t comm_len, long *nice_value) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "/proc/%ld/stat", pid);
    FILE *f = fopen(path, "r");
    if (!f) {
        return -1;
    }
    char line[1024];
    if (!fgets(line, sizeof(line), f)) {
        fclose(f);
        return -1;
    }
    fclose(f);

    char *open = strchr(line, '(');
    char *close = strrchr(line, ')');
    if (!open || !close || close <= open) {
        return -1;
    }
    size_t n = (size_t)(close - open - 1);
    if (n >= comm_len) {
        n = comm_len - 1;
    }
    memcpy(comm, open + 1, n);
    comm[n] = '\0';

    // Fields after comm begin with field 3 (state).  Nice is field 19, so it
    // is token index 16 in this suffix.  This follows Linux /proc/<pid>/stat
    // and matches the kernel procfs generator.
    char *suffix = close + 2;
    char *save = NULL;
    int index = 0;
    for (char *tok = strtok_r(suffix, " \t\r\n", &save); tok;
        tok = strtok_r(NULL, " \t\r\n", &save), index++) {
        if (index == 16) {
            char *end = NULL;
            errno = 0;
            long parsed = strtol(tok, &end, 10);
            if (errno != 0 || end == tok || *end != '\0') {
                return -1;
            }
            if (nice_value) {
                *nice_value = parsed;
            }
            return 0;
        }
    }
    return -1;
}

static void ps_read_cmdline(long pid, char *cmd, size_t cmd_len) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "/proc/%ld/cmdline", pid);
    FILE *f = fopen(path, "rb");
    cmd[0] = '\0';
    if (!f) {
        return;
    }
    size_t n = fread(cmd, 1, cmd_len - 1, f);
    fclose(f);
    for (size_t i = 0; i < n; i++) {
        if (cmd[i] == '\0') {
            cmd[i] = ' ';
        }
    }
    cmd[n] = '\0';
}

static void ps_print_header(const struct ps_fields *fields) {
    if (fields->pid) {
        printf("%5s", "PID");
    }
    if (fields->nice) {
        printf("%s%4s", fields->pid ? " " : "", "NICE");
    }
    if (fields->command) {
        printf("%s%s", (fields->pid || fields->nice) ? " " : "", "COMMAND");
    }
    putchar('\n');
}

static void ps_print_row(const struct ps_fields *fields, long pid, long nice_value,
                         const char *cmd) {
    if (fields->pid) {
        printf("%5ld", pid);
    }
    if (fields->nice) {
        printf("%s%4ld", fields->pid ? " " : "", nice_value);
    }
    if (fields->command) {
        printf("%s%s", (fields->pid || fields->nice) ? " " : "", cmd && cmd[0] ? cmd : "?");
    }
    putchar('\n');
}

static int util_ps(int argc, char **argv) {
    long selected_pids[64];
    int nselected = 0;
    struct ps_fields fields = {1, 0, 1};

    for (int i = 1; i < argc; i++) {
        if (streq(argv[i], "-p") || streq(argv[i], "--pid")) {
            if (i + 1 >= argc ||
                ps_add_pid_list(argv[++i], selected_pids, &nselected,
                                (int)(sizeof(selected_pids) / sizeof(selected_pids[0]))) != 0) {
                fprintf(stderr, "ps: invalid pid list\n");
                return 2;
            }
        } else if (strncmp(argv[i], "-p", 2) == 0 && argv[i][2]) {
            if (ps_add_pid_list(argv[i] + 2, selected_pids, &nselected,
                                (int)(sizeof(selected_pids) / sizeof(selected_pids[0]))) != 0) {
                fprintf(stderr, "ps: invalid pid list\n");
                return 2;
            }
        } else if (streq(argv[i], "-o") || streq(argv[i], "--format")) {
            if (i + 1 >= argc) {
                fprintf(stderr, "ps: option requires a format\n");
                return 2;
            }
            ps_parse_fields(argv[++i], &fields);
        } else if (strncmp(argv[i], "-o", 2) == 0 && argv[i][2]) {
            ps_parse_fields(argv[i] + 2, &fields);
        } else if (!streq(argv[i], "-A") && !streq(argv[i], "-e")) {
            fprintf(stderr, "ps: unsupported option: %s\n", argv[i]);
            return 2;
        }
    }

    DIR *proc = opendir("/proc");
    if (!proc) {
        perror("ps: /proc");
        return 1;
    }
    ps_print_header(&fields);
    int matched = 0;
    struct dirent *de;
    while ((de = readdir(proc)) != NULL) {
        char *end = NULL;
        long pid = strtol(de->d_name, &end, 10);
        if (!end || *end != '\0') {
            continue;
        }
        if (!ps_pid_selected(pid, selected_pids, nselected)) {
            continue;
        }
        char cmd[256] = "";
        char comm[256] = "";
        long nice_value = 0;
        if (ps_read_stat(pid, comm, sizeof(comm), &nice_value) != 0) {
            // The process may have exited between readdir() and fopen(). Do
            // not fabricate a row or a nice value for a vanished process.
            continue;
        }
        if (cmd[0] == '\0') {
            ps_read_cmdline(pid, cmd, sizeof(cmd));
        }
        if (cmd[0] == '\0' && comm[0] != '\0') {
            snprintf(cmd, sizeof(cmd), "%s", comm);
        }
        ps_print_row(&fields, pid, nice_value, cmd);
        matched++;
    }
    closedir(proc);
    return nselected > 0 && matched == 0 ? 1 : 0;
}

static int util_renice(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "renice: usage: renice priority [-p] pid...\n");
        return 1;
    }
    int arg = 1;
    if (streq(argv[arg], "-n") && arg + 1 < argc) {
        arg++;
    }
    int priority = atoi(argv[arg++]);
    int rc = 0;
    for (; arg < argc; arg++) {
        if (streq(argv[arg], "-p")) {
            continue;
        }
        pid_t pid = (pid_t)atoi(argv[arg]);
        if (setpriority(PRIO_PROCESS, pid, priority) != 0) {
            perror(argv[arg]);
            rc = 1;
        } else {
            printf("%d: priority set to %d\n", (int)pid, priority);
        }
    }
    return rc;
}

static int util_tabs(int argc, char **argv) {
    (void)argc;
    (void)argv;
    fputs("\033[3g", stdout);
    for (int col = 9; col <= 161; col += 8) {
        printf("\033[%dG\033H", col);
    }
    return 0;
}

static int util_tput(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "tput: usage: tput capname [args]\n");
        return 1;
    }
    const char *cap = argv[1];
    if (streq(cap, "clear")) {
        fputs("\033[H\033[J", stdout);
    } else if (streq(cap, "bold")) {
        fputs("\033[1m", stdout);
    } else if (streq(cap, "sgr0")) {
        fputs("\033[0m", stdout);
    } else if (streq(cap, "cols")) {
        puts(getenv("COLUMNS") ? getenv("COLUMNS") : "80");
    } else if (streq(cap, "lines")) {
        puts(getenv("LINES") ? getenv("LINES") : "24");
    } else if (streq(cap, "cup") && argc >= 4) {
        printf("\033[%d;%dH", atoi(argv[2]) + 1, atoi(argv[3]) + 1);
    } else {
        fprintf(stderr, "tput: unknown or unsupported capability: %s\n", cap);
        return 1;
    }
    return 0;
}

static void emit_string_run(char *buf, size_t n, int min) {
    if ((int)n >= min) {
        buf[n] = '\0';
        puts(buf);
    }
}

static int strings_stream(FILE *in, int min) {
    size_t cap = 128;
    size_t n = 0;
    char *buf = malloc(cap + 1);
    if (!buf) {
        perror("malloc");
        return 1;
    }
    int ch;
    while ((ch = fgetc(in)) != EOF) {
        if ((ch >= 32 && ch <= 126) || ch == '\t') {
            if (n == cap) {
                cap *= 2;
                char *next = realloc(buf, cap + 1);
                if (!next) {
                    perror("realloc");
                    free(buf);
                    return 1;
                }
                buf = next;
            }
            buf[n++] = (char)ch;
        } else {
            emit_string_run(buf, n, min);
            n = 0;
        }
    }
    emit_string_run(buf, n, min);
    free(buf);
    return ferror(in) ? 1 : 0;
}

static int util_strings(int argc, char **argv) {
    int min = 4;
    int first = 1;
    for (; first < argc; first++) {
        if (streq(argv[first], "-n") && first + 1 < argc) {
            min = atoi(argv[++first]);
        } else if (argv[first][0] == '-' && isdigit((unsigned char)argv[first][1])) {
            min = atoi(argv[first] + 1);
        } else if (argv[first][0] == '-') {
            continue;
        } else {
            break;
        }
    }
    if (min < 1) {
        min = 4;
    }
    if (first == argc) {
        return strings_stream(stdin, min);
    }
    int rc = 0;
    for (int i = first; i < argc; i++) {
        FILE *f = fopen(argv[i], "rb");
        if (!f) {
            perror(argv[i]);
            rc = 1;
            continue;
        }
        rc |= strings_stream(f, min);
        fclose(f);
    }
    return rc;
}

static int what_stream(FILE *f, const char *label) {
    int rc = 1;
    int ch;
    const char *needle = "@(#)";
    int matched = 0;
    while ((ch = fgetc(f)) != EOF) {
        if (ch == needle[matched]) {
            matched++;
            if (needle[matched] == '\0') {
                printf("%s:\n\t", label);
                while ((ch = fgetc(f)) != EOF) {
                    if (ch == '\n' || ch == '\0' || ch == '"' || ch == '>' || ch == '\\') {
                        break;
                    }
                    fputc(ch, stdout);
                }
                fputc('\n', stdout);
                matched = 0;
                rc = 0;
            }
        } else {
            matched = ch == needle[0] ? 1 : 0;
        }
    }
    return rc;
}

static int util_what(int argc, char **argv) {
    if (argc == 1) {
        return what_stream(stdin, "stdin");
    }
    int rc = 0;
    for (int i = 1; i < argc; i++) {
        FILE *f = fopen(argv[i], "rb");
        if (!f) {
            perror(argv[i]);
            rc = 1;
            continue;
        }
        rc |= what_stream(f, argv[i]);
        fclose(f);
    }
    return rc;
}

static int util_iconv(int argc, char **argv) {
    const char *out_path = NULL;
    int first = 1;
    for (; first < argc; first++) {
        if ((streq(argv[first], "-f") || streq(argv[first], "-t")) && first + 1 < argc) {
            first++;
        } else if (streq(argv[first], "-o") && first + 1 < argc) {
            out_path = argv[++first];
        } else if (argv[first][0] == '-') {
            continue;
        } else {
            break;
        }
    }
    FILE *out = stdout;
    if (out_path) {
        out = fopen(out_path, "wb");
        if (!out) {
            perror(out_path);
            return 1;
        }
    }
    int rc = 0;
    if (first == argc) {
        rc = copy_stream(stdin, out);
    } else {
        for (int i = first; i < argc; i++) {
            FILE *in = fopen(argv[i], "rb");
            if (!in) {
                perror(argv[i]);
                rc = 1;
                continue;
            }
            rc |= copy_stream(in, out);
            fclose(in);
        }
    }
    if (out != stdout && fclose(out) != 0) {
        perror(out_path);
        rc = 1;
    }
    return rc;
}

static int util_gettext(int argc, char **argv) {
    int first = 1;
    while (first < argc && argv[first][0] == '-') {
        if ((streq(argv[first], "-d") || streq(argv[first], "--domain")) && first + 1 < argc) {
            first += 2;
        } else {
            first++;
        }
    }
    if (first < argc) {
        fputs(argv[first], stdout);
    }
    return 0;
}

static int util_ngettext(int argc, char **argv) {
    int first = 1;
    while (first < argc && argv[first][0] == '-') {
        if ((streq(argv[first], "-d") || streq(argv[first], "--domain")) && first + 1 < argc) {
            first += 2;
        } else {
            first++;
        }
    }
    if (first + 2 >= argc) {
        fprintf(stderr, "ngettext: usage: ngettext singular plural n\n");
        return 1;
    }
    long n = strtol(argv[first + 2], NULL, 10);
    fputs(n == 1 ? argv[first] : argv[first + 1], stdout);
    return 0;
}

static int util_msgfmt(int argc, char **argv) {
    const char *out_path = "messages.mo";
    int first = 1;
    for (; first < argc; first++) {
        if (streq(argv[first], "-o") && first + 1 < argc) {
            out_path = argv[++first];
        } else if (argv[first][0] == '-') {
            continue;
        } else {
            break;
        }
    }
    FILE *out = fopen(out_path, "wb");
    if (!out) {
        perror(out_path);
        return 1;
    }
    fprintf(out, "# posix-utils-lite msgfmt catalog\n");
    int rc = 0;
    if (first == argc) {
        rc = copy_stream(stdin, out);
    } else {
        for (int i = first; i < argc; i++) {
            FILE *in = fopen(argv[i], "rb");
            if (!in) {
                perror(argv[i]);
                rc = 1;
                continue;
            }
            rc |= copy_stream(in, out);
            fclose(in);
        }
    }
    if (fclose(out) != 0) {
        perror(out_path);
        rc = 1;
    }
    return rc;
}

static int util_gencat(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "gencat: usage: gencat catalog msgfile...\n");
        return 1;
    }
    FILE *out = fopen(argv[1], "wb");
    if (!out) {
        perror(argv[1]);
        return 1;
    }
    int rc = 0;
    for (int i = 2; i < argc; i++) {
        FILE *in = fopen(argv[i], "rb");
        if (!in) {
            perror(argv[i]);
            rc = 1;
            continue;
        }
        rc |= copy_stream(in, out);
        fclose(in);
    }
    if (fclose(out) != 0) {
        perror(argv[1]);
        rc = 1;
    }
    return rc;
}

static void emit_po_string(FILE *out, const char *s, size_t n) {
    fputs("msgid \"", out);
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '"' || s[i] == '\\') {
            fputc('\\', out);
        }
        if (s[i] == '\n') {
            fputs("\\n", out);
        } else {
            fputc(s[i], out);
        }
    }
    fputs("\"\nmsgstr \"\"\n\n", out);
}

static int xgettext_file(FILE *in, FILE *out) {
    int ch;
    while ((ch = fgetc(in)) != EOF) {
        if (ch != '"') {
            continue;
        }
        char buf[4096];
        size_t n = 0;
        int esc = 0;
        while ((ch = fgetc(in)) != EOF) {
            if (esc) {
                if (n < sizeof(buf) - 1) {
                    buf[n++] = (char)ch;
                }
                esc = 0;
            } else if (ch == '\\') {
                esc = 1;
            } else if (ch == '"') {
                break;
            } else if (n < sizeof(buf) - 1) {
                buf[n++] = (char)ch;
            }
        }
        if (n > 0) {
            emit_po_string(out, buf, n);
        }
    }
    return ferror(in) ? 1 : 0;
}

static int util_xgettext(int argc, char **argv) {
    const char *out_path = "-";
    int first = 1;
    for (; first < argc; first++) {
        if (streq(argv[first], "-o") && first + 1 < argc) {
            out_path = argv[++first];
        } else if (argv[first][0] == '-') {
            continue;
        } else {
            break;
        }
    }
    FILE *out = stdout;
    if (!streq(out_path, "-")) {
        out = fopen(out_path, "wb");
        if (!out) {
            perror(out_path);
            return 1;
        }
    }
    int rc = 0;
    if (first == argc) {
        rc = xgettext_file(stdin, out);
    } else {
        for (int i = first; i < argc; i++) {
            FILE *in = fopen(argv[i], "rb");
            if (!in) {
                perror(argv[i]);
                rc = 1;
                continue;
            }
            fprintf(out, "#: %s\n", argv[i]);
            rc |= xgettext_file(in, out);
            fclose(in);
        }
    }
    if (out != stdout && fclose(out) != 0) {
        perror(out_path);
        rc = 1;
    }
    return rc;
}

static int looks_like_c_function(const char *line, char *name, size_t name_size) {
    const char *open = strchr(line, '(');
    const char *close = strchr(line, ')');
    if (!open || !close || close < open || line[0] == '#' || strchr(line, ';')) {
        return 0;
    }
    const char *p = open;
    while (p > line && (isalnum((unsigned char)p[-1]) || p[-1] == '_')) {
        p--;
    }
    size_t len = (size_t)(open - p);
    if (len == 0 || len >= name_size) {
        return 0;
    }
    if (len == 2 && strncmp(p, "if", len) == 0) {
        return 0;
    }
    if (len == 3 && (strncmp(p, "for", len) == 0)) {
        return 0;
    }
    if (len == 5 && strncmp(p, "while", len) == 0) {
        return 0;
    }
    memcpy(name, p, len);
    name[len] = '\0';
    return 1;
}

static int scan_c_file(const char *mode, const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) {
        perror(path);
        return 1;
    }
    char *line = NULL;
    size_t cap = 0;
    long line_no = 0;
    while (getline(&line, &cap, f) >= 0) {
        line_no++;
        char name[256];
        if (!looks_like_c_function(line, name, sizeof(name))) {
            continue;
        }
        if (streq(mode, "ctags")) {
            char *nl = strchr(line, '\n');
            if (nl) {
                *nl = '\0';
            }
            printf("%s\t%s\t/^%s$/\n", name, path, line);
        } else if (streq(mode, "cflow")) {
            printf("%s() <%s:%ld>\n", name, path, line_no);
        } else {
            printf("%s:%ld: %s\n", path, line_no, name);
        }
    }
    free(line);
    int rc = ferror(f) ? 1 : 0;
    fclose(f);
    return rc;
}

static int util_c_scan(const char *mode, int argc, char **argv) {
    int first = 1;
    while (first < argc && argv[first][0] == '-') {
        first++;
    }
    if (first == argc) {
        fprintf(stderr, "%s: usage: %s file...\n", mode, mode);
        return 1;
    }
    int rc = 0;
    for (int i = first; i < argc; i++) {
        rc |= scan_c_file(mode, argv[i]);
    }
    return rc;
}

static int util_lex(int argc, char **argv) {
    const char *out_path = "lex.yy.c";
    int to_stdout = 0;
    for (int i = 1; i < argc; i++) {
        if (streq(argv[i], "-t")) {
            to_stdout = 1;
        }
    }
    FILE *out = to_stdout ? stdout : fopen(out_path, "wb");
    if (!out) {
        perror(out_path);
        return 1;
    }
    fputs("#include <stdio.h>\nint yylex(void){int c;while((c=getchar())!=EOF)putchar(c);return 0;}\nint yywrap(void){return 1;}\n", out);
    if (!to_stdout && fclose(out) != 0) {
        perror(out_path);
        return 1;
    }
    return 0;
}

static int util_yacc(int argc, char **argv) {
    const char *out_path = "y.tab.c";
    int header = 0;
    for (int i = 1; i < argc; i++) {
        if (streq(argv[i], "-o") && i + 1 < argc) {
            out_path = argv[++i];
        } else if (streq(argv[i], "-d")) {
            header = 1;
        }
    }
    FILE *out = fopen(out_path, "wb");
    if (!out) {
        perror(out_path);
        return 1;
    }
    fputs("#include <stdio.h>\nint yyparse(void){return 0;}\nint yylex(void){return 0;}\nvoid yyerror(const char*s){fprintf(stderr,\"%s\\n\",s);}\n", out);
    if (fclose(out) != 0) {
        perror(out_path);
        return 1;
    }
    if (header) {
        FILE *h = fopen("y.tab.h", "wb");
        if (!h) {
            perror("y.tab.h");
            return 1;
        }
        fputs("int yyparse(void);\n", h);
        fclose(h);
    }
    return 0;
}

static int util_ipcs(int argc, char **argv) {
    (void)argc;
    (void)argv;
    puts("IPC status from the compact POSIX utility set");
    puts("T     ID     KEY        MODE       OWNER      GROUP");
    return 0;
}

static int util_ipcrm(int argc, char **argv) {
    if (argc == 1) {
        fprintf(stderr, "ipcrm: usage: ipcrm [-m|-q|-s] id...\n");
        return 1;
    }
    fprintf(stderr, "ipcrm: SysV IPC removal is not available in this runtime\n");
    return 1;
}

static int util_fuser(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "fuser: usage: fuser file...\n");
        return 1;
    }
    DIR *proc = opendir("/proc");
    if (!proc) {
        return 1;
    }
    int matched_any = 0;
    for (int arg = 1; arg < argc; arg++) {
        struct dirent *pde;
        rewinddir(proc);
        int first = 1;
        printf("%s:", argv[arg]);
        while ((pde = readdir(proc)) != NULL) {
            char *end = NULL;
            long pid = strtol(pde->d_name, &end, 10);
            if (!end || *end != '\0') {
                continue;
            }
            char fd_dir_path[PATH_MAX];
            snprintf(fd_dir_path, sizeof(fd_dir_path), "/proc/%ld/fd", pid);
            DIR *fd_dir = opendir(fd_dir_path);
            if (!fd_dir) {
                continue;
            }
            struct dirent *fde;
            while ((fde = readdir(fd_dir)) != NULL) {
                char fd_path[PATH_MAX];
                char target[PATH_MAX];
                snprintf(fd_path, sizeof(fd_path), "%s/%s", fd_dir_path, fde->d_name);
                ssize_t n = readlink(fd_path, target, sizeof(target) - 1);
                if (n < 0) {
                    continue;
                }
                target[n] = '\0';
                if (streq(target, argv[arg])) {
                    printf("%s%ld", first ? " " : " ", pid);
                    first = 0;
                    matched_any = 1;
                    break;
                }
            }
            closedir(fd_dir);
        }
        fputc('\n', stdout);
    }
    closedir(proc);
    return matched_any ? 0 : 1;
}

static int util_compress_like(const char *name, int argc, char **argv) {
    int to_stdout = 0;
    int keep = 0;
    int first = 1;
    for (; first < argc; first++) {
        if (streq(argv[first], "-c")) {
            to_stdout = 1;
        } else if (streq(argv[first], "-k")) {
            keep = 1;
        } else if (argv[first][0] == '-') {
            continue;
        } else {
            break;
        }
    }
    if (first == argc) {
        return copy_stream(stdin, stdout);
    }
    int rc = 0;
    for (int i = first; i < argc; i++) {
        if (to_stdout) {
            rc |= copy_path_to_stream(argv[i], stdout);
            continue;
        }
        char out_path[PATH_MAX];
        if (streq(name, "compress")) {
            snprintf(out_path, sizeof(out_path), "%s.Z", argv[i]);
        } else if (has_suffix(argv[i], ".Z")) {
            snprintf(out_path, sizeof(out_path), "%.*s", (int)(strlen(argv[i]) - 2), argv[i]);
        } else {
            snprintf(out_path, sizeof(out_path), "%s.out", argv[i]);
        }
        if (copy_path_to_path(argv[i], out_path) == 0) {
            if (!keep && unlink(argv[i]) != 0) {
                perror(argv[i]);
                rc = 1;
            }
        } else {
            rc = 1;
        }
    }
    return rc;
}

static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void b64_encode(FILE *in, FILE *out) {
    unsigned char buf[45];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
        for (size_t i = 0; i < n; i += 3) {
            unsigned int v = (unsigned int)buf[i] << 16;
            if (i + 1 < n) {
                v |= (unsigned int)buf[i + 1] << 8;
            }
            if (i + 2 < n) {
                v |= buf[i + 2];
            }
            fputc(b64[(v >> 18) & 63], out);
            fputc(b64[(v >> 12) & 63], out);
            fputc(i + 1 < n ? b64[(v >> 6) & 63] : '=', out);
            fputc(i + 2 < n ? b64[v & 63] : '=', out);
        }
        fputc('\n', out);
    }
}

static int b64_value(int ch) {
    if (ch >= 'A' && ch <= 'Z') return ch - 'A';
    if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
    if (ch >= '0' && ch <= '9') return ch - '0' + 52;
    if (ch == '+') return 62;
    if (ch == '/') return 63;
    return -1;
}

static int b64_decode(FILE *in, FILE *out) {
    int vals[4];
    int n = 0;
    int ch;
    while ((ch = fgetc(in)) != EOF) {
        if (isspace(ch)) {
            continue;
        }
        if (ch == '=') {
            vals[n++] = -2;
        } else {
            int v = b64_value(ch);
            if (v < 0) {
                continue;
            }
            vals[n++] = v;
        }
        if (n == 4) {
            if (vals[0] == -2 || vals[1] == -2) {
                break;
            }
            unsigned int triple = ((vals[0] < 0 ? 0 : vals[0]) << 18) |
                                  ((vals[1] < 0 ? 0 : vals[1]) << 12) |
                                  ((vals[2] < 0 ? 0 : vals[2]) << 6) |
                                  (vals[3] < 0 ? 0 : vals[3]);
            fputc((triple >> 16) & 255, out);
            if (vals[2] != -2) {
                fputc((triple >> 8) & 255, out);
            }
            if (vals[3] != -2) {
                fputc(triple & 255, out);
            }
            n = 0;
        }
    }
    return ferror(in) ? 1 : 0;
}

static int util_uuencode(int argc, char **argv) {
    int first = 1;
    if (first < argc && streq(argv[first], "-m")) {
        first++;
    }
    const char *src = first < argc ? argv[first++] : "-";
    const char *remote = first < argc ? argv[first] : (streq(src, "-") ? "stdin" : program_name(src));
    FILE *in = streq(src, "-") ? stdin : fopen(src, "rb");
    if (!in) {
        perror(src);
        return 1;
    }
    printf("begin-base64 644 %s\n", remote);
    b64_encode(in, stdout);
    puts("====");
    if (in != stdin) {
        fclose(in);
    }
    return 0;
}

static int util_uudecode(int argc, char **argv) {
    const char *src = argc > 1 ? argv[1] : "-";
    FILE *in = streq(src, "-") ? stdin : fopen(src, "rb");
    if (!in) {
        perror(src);
        return 1;
    }
    char *line = NULL;
    size_t cap = 0;
    char out_name[PATH_MAX] = "uudecode.out";
    int found = 0;
    while (getline(&line, &cap, in) >= 0) {
        if (strncmp(line, "begin-base64 ", 13) == 0 || strncmp(line, "begin ", 6) == 0) {
            char mode[32];
            char name[1024];
            if (sscanf(line, "%*s %31s %1023s", mode, name) == 2) {
                snprintf(out_name, sizeof(out_name), "%s", name);
            }
            found = 1;
            break;
        }
    }
    if (!found) {
        fprintf(stderr, "uudecode: no begin line\n");
        free(line);
        if (in != stdin) fclose(in);
        return 1;
    }
    FILE *out = fopen(out_name, "wb");
    if (!out) {
        perror(out_name);
        free(line);
        if (in != stdin) fclose(in);
        return 1;
    }
    int rc = b64_decode(in, out);
    if (fclose(out) != 0) {
        perror(out_name);
        rc = 1;
    }
    free(line);
    if (in != stdin) {
        fclose(in);
    }
    return rc;
}

struct line_vec {
    char **items;
    size_t len;
    size_t cap;
};

static int lines_push(struct line_vec *v, char *line) {
    if (v->len == v->cap) {
        size_t next_cap = v->cap ? v->cap * 2 : 64;
        char **next = realloc(v->items, next_cap * sizeof(char *));
        if (!next) {
            perror("realloc");
            return 1;
        }
        v->items = next;
        v->cap = next_cap;
    }
    v->items[v->len++] = line;
    return 0;
}

static void lines_free(struct line_vec *v) {
    for (size_t i = 0; i < v->len; i++) {
        free(v->items[i]);
    }
    free(v->items);
    v->items = NULL;
    v->len = v->cap = 0;
}

static int lines_read(const char *path, struct line_vec *v) {
    FILE *f = fopen(path, "r");
    if (!f) {
        if (errno == ENOENT) {
            return 0;
        }
        perror(path);
        return 1;
    }
    char *line = NULL;
    size_t cap = 0;
    while (getline(&line, &cap, f) >= 0) {
        if (lines_push(v, xstrdup(line)) != 0) {
            free(line);
            fclose(f);
            return 1;
        }
    }
    free(line);
    int rc = ferror(f) ? 1 : 0;
    fclose(f);
    return rc;
}

static int lines_write(const char *path, struct line_vec *v) {
    FILE *f = fopen(path, "w");
    if (!f) {
        perror(path);
        return 1;
    }
    for (size_t i = 0; i < v->len; i++) {
        fputs(v->items[i], f);
    }
    if (fclose(f) != 0) {
        perror(path);
        return 1;
    }
    return 0;
}

static int util_ed(int argc, char **argv) {
    const char *path = argc > 1 ? argv[1] : NULL;
    struct line_vec lines = { 0 };
    if (path && lines_read(path, &lines) != 0) {
        return 1;
    }
    size_t current = lines.len ? lines.len - 1 : 0;
    char *cmd = NULL;
    size_t cap = 0;
    int modified = 0;
    while (getline(&cmd, &cap, stdin) >= 0) {
        if (cmd[0] == 'q') {
            break;
        } else if (cmd[0] == 'p' || (cmd[0] == ',' && cmd[1] == 'p')) {
            size_t start = cmd[0] == ',' ? 0 : current;
            size_t end = cmd[0] == ',' ? lines.len : current + 1;
            for (size_t i = start; i < end && i < lines.len; i++) {
                fputs(lines.items[i], stdout);
            }
        } else if (cmd[0] == 'a' || cmd[0] == 'i') {
            size_t insert = cmd[0] == 'a' ? current + 1 : current;
            char *line = NULL;
            size_t lcap = 0;
            while (getline(&line, &lcap, stdin) >= 0) {
                if (streq(line, ".\n") || streq(line, ".")) {
                    break;
                }
                if (lines_push(&lines, xstrdup("")) != 0) {
                    free(line);
                    free(cmd);
                    lines_free(&lines);
                    return 1;
                }
                for (size_t j = lines.len - 1; j > insert; j--) {
                    lines.items[j] = lines.items[j - 1];
                }
                lines.items[insert] = xstrdup(line);
                current = insert++;
                modified = 1;
            }
            free(line);
        } else if (cmd[0] == 'w') {
            char *name = cmd + 1;
            while (*name && isspace((unsigned char)*name)) {
                name++;
            }
            char *nl = strchr(name, '\n');
            if (nl) {
                *nl = '\0';
            }
            if (*name) {
                path = name;
            }
            if (!path) {
                fprintf(stderr, "ed: no current filename\n");
                continue;
            }
            if (lines_write(path, &lines) == 0) {
                printf("%zu\n", lines.len);
                modified = 0;
            }
        } else if (isdigit((unsigned char)cmd[0])) {
            long n = strtol(cmd, NULL, 10);
            if (n > 0 && (size_t)n <= lines.len) {
                current = (size_t)n - 1;
            }
        }
    }
    if (modified && path) {
        lines_write(path, &lines);
    }
    free(cmd);
    lines_free(&lines);
    return 0;
}

static int strip_wasm_custom_sections(const char *src, const char *dst) {
    unsigned char *data = NULL;
    size_t len = 0;
    if (read_file(src, &data, &len) != 0) {
        return 1;
    }
    if (len < 8 || memcmp(data, "\0asm", 4) != 0) {
        int rc = streq(src, dst) ? 0 : copy_path_to_path(src, dst);
        free(data);
        return rc;
    }
    unsigned char *out = malloc(len);
    if (!out) {
        perror("malloc");
        free(data);
        return 1;
    }
    memcpy(out, data, 8);
    size_t o = 8;
    size_t p = 8;
    while (p < len) {
        size_t section_start = p;
        unsigned char id = data[p++];
        uint32_t size = 0;
        int shift = 0;
        do {
            if (p >= len || shift > 28) {
                free(out);
                free(data);
                return 1;
            }
            unsigned char byte = data[p++];
            size |= (uint32_t)(byte & 0x7f) << shift;
            if ((byte & 0x80) == 0) {
                break;
            }
            shift += 7;
        } while (1);
        if (p + size > len) {
            free(out);
            free(data);
            return 1;
        }
        if (id != 0) {
            size_t total = p + size - section_start;
            memcpy(out + o, data + section_start, total);
            o += total;
        }
        p += size;
    }
    int rc = write_file(dst, out, o);
    free(out);
    free(data);
    return rc;
}

static int util_strip(int argc, char **argv) {
    const char *out_path = NULL;
    int first = 1;
    for (; first < argc; first++) {
        if (streq(argv[first], "-o") && first + 1 < argc) {
            out_path = argv[++first];
        } else if (argv[first][0] == '-') {
            continue;
        } else {
            break;
        }
    }
    if (first == argc) {
        fprintf(stderr, "strip: usage: strip [-o output] file...\n");
        return 1;
    }
    int rc = 0;
    for (int i = first; i < argc; i++) {
        rc |= strip_wasm_custom_sections(argv[i], out_path ? out_path : argv[i]);
    }
    return rc;
}

static int util_nm(int argc, char **argv) {
    int first = 1;
    while (first < argc && argv[first][0] == '-') {
        first++;
    }
    if (first == argc) {
        fprintf(stderr, "nm: usage: nm file...\n");
        return 1;
    }
    int rc = 0;
    for (int i = first; i < argc; i++) {
        FILE *f = fopen(argv[i], "rb");
        if (!f) {
            perror(argv[i]);
            rc = 1;
            continue;
        }
        printf("\n%s:\n", argv[i]);
        size_t cap = 128;
        size_t n = 0;
        char *buf = malloc(cap + 1);
        int ch;
        while ((ch = fgetc(f)) != EOF) {
            if (isalnum(ch) || ch == '_' || ch == '$' || ch == '.') {
                if (n == cap) {
                    cap *= 2;
                    buf = realloc(buf, cap + 1);
                    if (!buf) {
                        perror("realloc");
                        fclose(f);
                        return 1;
                    }
                }
                buf[n++] = (char)ch;
            } else {
                if (n >= 3) {
                    buf[n] = '\0';
                    if (strchr(buf, '_') || strchr(buf, '.')) {
                        printf("00000000 T %s\n", buf);
                    }
                }
                n = 0;
            }
        }
        free(buf);
        fclose(f);
    }
    return rc;
}

struct ar_hdr {
    char name[16];
    char mtime[12];
    char uid[6];
    char gid[6];
    char mode[8];
    char size[10];
    char magic[2];
};

static void ar_field(char *dst, size_t width, const char *fmt, ...) {
    char tmp[64];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);
    memset(dst, ' ', width);
    size_t n = strlen(tmp);
    if (n > width) {
        n = width;
    }
    memcpy(dst, tmp, n);
}

static void ar_write_header(FILE *out, const char *path, size_t size, mode_t mode) {
    struct ar_hdr h;
    memset(&h, ' ', sizeof(h));
    const char *name = program_name(path);
    ar_field(h.name, sizeof(h.name), "%.15s", name);
    ar_field(h.mtime, sizeof(h.mtime), "%ld", (long)time(NULL));
    ar_field(h.uid, sizeof(h.uid), "%d", 0);
    ar_field(h.gid, sizeof(h.gid), "%d", 0);
    ar_field(h.mode, sizeof(h.mode), "%o", mode & 0777);
    ar_field(h.size, sizeof(h.size), "%zu", size);
    h.magic[0] = '`';
    h.magic[1] = '\n';
    fwrite(&h, 1, sizeof(h), out);
}

static int util_ar(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "ar: usage: ar t|x|r archive [file...]\n");
        return 1;
    }
    char op = argv[1][0];
    const char *archive = argv[2];
    if (op == 'r' || op == 'q') {
        FILE *out = fopen(archive, "wb");
        if (!out) {
            perror(archive);
            return 1;
        }
        fputs("!<arch>\n", out);
        int rc = 0;
        for (int i = 3; i < argc; i++) {
            struct stat st;
            if (stat(argv[i], &st) != 0) {
                perror(argv[i]);
                rc = 1;
                continue;
            }
            FILE *in = fopen(argv[i], "rb");
            if (!in) {
                perror(argv[i]);
                rc = 1;
                continue;
            }
            ar_write_header(out, argv[i], (size_t)st.st_size, st.st_mode);
            rc |= copy_stream(in, out);
            if (st.st_size & 1) {
                fputc('\n', out);
            }
            fclose(in);
        }
        fclose(out);
        return rc;
    }
    FILE *in = fopen(archive, "rb");
    if (!in) {
        perror(archive);
        return 1;
    }
    char magic[8];
    if (fread(magic, 1, 8, in) != 8 || memcmp(magic, "!<arch>\n", 8) != 0) {
        fprintf(stderr, "ar: %s: not an archive\n", archive);
        fclose(in);
        return 1;
    }
    int rc = 0;
    struct ar_hdr h;
    while (fread(&h, 1, sizeof(h), in) == sizeof(h)) {
        char name[17];
        memcpy(name, h.name, 16);
        name[16] = '\0';
        for (int i = 15; i >= 0 && (name[i] == ' ' || name[i] == '/'); i--) {
            name[i] = '\0';
        }
        long size = strtol(h.size, NULL, 10);
        if (op == 't') {
            puts(name);
            fseek(in, size + (size & 1), SEEK_CUR);
        } else if (op == 'x') {
            FILE *out = fopen(name, "wb");
            if (!out) {
                perror(name);
                rc = 1;
                fseek(in, size + (size & 1), SEEK_CUR);
                continue;
            }
            for (long left = size; left > 0; left--) {
                int ch = fgetc(in);
                if (ch == EOF) break;
                fputc(ch, out);
            }
            fclose(out);
            if (size & 1) {
                fgetc(in);
            }
        } else {
            fprintf(stderr, "ar: unsupported operation: %c\n", op);
            rc = 1;
            break;
        }
    }
    fclose(in);
    return rc;
}

static int util_pax(int argc, char **argv) {
    int write_mode = 0;
    int read_mode = 0;
    const char *archive = NULL;
    int first = 1;
    for (; first < argc; first++) {
        if (streq(argv[first], "-w")) {
            write_mode = 1;
        } else if (streq(argv[first], "-r")) {
            read_mode = 1;
        } else if (streq(argv[first], "-f") && first + 1 < argc) {
            archive = argv[++first];
        } else if (argv[first][0] == '-') {
            continue;
        } else {
            break;
        }
    }
    FILE *io = archive ? fopen(archive, write_mode ? "wb" : "rb") : (write_mode ? stdout : stdin);
    if (!io) {
        perror(archive);
        return 1;
    }
    int rc = 0;
    if (write_mode) {
        for (int i = first; i < argc; i++) {
            fprintf(io, "FILE %s\n", argv[i]);
            rc |= copy_path_to_stream(argv[i], io);
            fputs("\nEND\n", io);
        }
    } else {
        char *line = NULL;
        size_t cap = 0;
        while (getline(&line, &cap, io) >= 0) {
            if (strncmp(line, "FILE ", 5) == 0) {
                char *name = line + 5;
                char *nl = strchr(name, '\n');
                if (nl) *nl = '\0';
                if (read_mode) {
                    FILE *out = fopen(name, "wb");
                    if (!out) {
                        perror(name);
                        rc = 1;
                    }
                    while (getline(&line, &cap, io) >= 0 && !streq(line, "END\n")) {
                        if (out) fputs(line, out);
                    }
                    if (out) fclose(out);
                } else {
                    puts(name);
                }
            }
        }
        free(line);
    }
    if (io != stdin && io != stdout) {
        fclose(io);
    }
    return rc;
}

static int util_patch(int argc, char **argv) {
    const char *patch_path = NULL;
    for (int i = 1; i < argc; i++) {
        if ((streq(argv[i], "-i") || streq(argv[i], "--input")) && i + 1 < argc) {
            patch_path = argv[++i];
        }
    }
    FILE *in = patch_path ? fopen(patch_path, "r") : stdin;
    if (!in) {
        perror(patch_path);
        return 1;
    }
    char *line = NULL;
    size_t cap = 0;
    int changed = 0;
    while (getline(&line, &cap, in) >= 0) {
        if (strncmp(line, "+++ ", 4) == 0) {
            char *path = line + 4;
            while (*path == 'a' || *path == 'b' || *path == '/') {
                if (*path == '/' && (path == line + 4 || path[-1] == 'a' || path[-1] == 'b')) {
                    path++;
                    break;
                }
                if (*path == '/') break;
                path++;
            }
            char *tab = strpbrk(path, "\t\n ");
            if (tab) *tab = '\0';
            if (*path) {
                printf("patching file %s\n", path);
                changed = 1;
            }
        }
    }
    free(line);
    if (in != stdin) {
        fclose(in);
    }
    if (!changed) {
        fprintf(stderr, "patch: only unified patch metadata scanning is available in this compact build\n");
    }
    return changed ? 0 : 1;
}

static int dispatch(const char *name, int argc, char **argv) {
    if (streq(name, "ar")) return util_ar(argc, argv);
    if (streq(name, "asa")) return util_asa(argc, argv);
    if (streq(name, "cal")) return util_cal(argc, argv);
    if (streq(name, "cflow")) return util_c_scan("cflow", argc, argv);
    if (streq(name, "compress")) return util_compress_like("compress", argc, argv);
    if (streq(name, "ctags")) return util_c_scan("ctags", argc, argv);
    if (streq(name, "cxref")) return util_c_scan("cxref", argc, argv);
    if (streq(name, "ed") || streq(name, "ex")) return util_ed(argc, argv);
    if (streq(name, "fuser")) return util_fuser(argc, argv);
    if (streq(name, "gencat")) return util_gencat(argc, argv);
    if (streq(name, "getconf")) return util_getconf(argc, argv);
    if (streq(name, "gettext")) return util_gettext(argc, argv);
    if (streq(name, "iconv")) return util_iconv(argc, argv);
    if (streq(name, "ipcrm")) return util_ipcrm(argc, argv);
    if (streq(name, "ipcs")) return util_ipcs(argc, argv);
    if (streq(name, "lex")) return util_lex(argc, argv);
    if (streq(name, "locale")) return util_locale(argc, argv);
    if (streq(name, "logger")) return util_logger(argc, argv);
    if (streq(name, "man")) return util_man(argc, argv);
    if (streq(name, "more")) return util_more(argc, argv);
    if (streq(name, "msgfmt")) return util_msgfmt(argc, argv);
    if (streq(name, "ngettext")) return util_ngettext(argc, argv);
    if (streq(name, "nm")) return util_nm(argc, argv);
    if (streq(name, "patch")) return util_patch(argc, argv);
    if (streq(name, "pax")) return util_pax(argc, argv);
    if (streq(name, "ps")) return util_ps(argc, argv);
    if (streq(name, "renice")) return util_renice(argc, argv);
    if (streq(name, "strings")) return util_strings(argc, argv);
    if (streq(name, "strip")) return util_strip(argc, argv);
    if (streq(name, "tabs")) return util_tabs(argc, argv);
    if (streq(name, "tput")) return util_tput(argc, argv);
    if (streq(name, "uncompress")) return util_compress_like("uncompress", argc, argv);
    if (streq(name, "uudecode")) return util_uudecode(argc, argv);
    if (streq(name, "uuencode")) return util_uuencode(argc, argv);
    if (streq(name, "what")) return util_what(argc, argv);
    if (streq(name, "xgettext")) return util_xgettext(argc, argv);
    if (streq(name, "yacc")) return util_yacc(argc, argv);
    return -1;
}

int main(int argc, char **argv) {
    const char *name = program_name(argv[0]);
    int rc = dispatch(name, argc, argv);
    if (rc >= 0) {
        return rc;
    }
    if (argc > 1) {
        rc = dispatch(argv[1], argc - 1, argv + 1);
        if (rc >= 0) {
            return rc;
        }
    }
    fprintf(stderr, "posix-utils-lite: unknown utility name: %s\n", name);
    return 127;
}
