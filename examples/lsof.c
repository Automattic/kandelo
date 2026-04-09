/*
 * lsof — list open files
 *
 * Reads /proc to enumerate processes and their open file descriptors.
 * Supports:
 *   lsof           — list all open files for all processes
 *   lsof -p <pid>  — list open files for a specific process
 *   lsof -c <name> — list open files matching command name
 *   lsof <file>    — list processes that have <file> open
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <unistd.h>
#include <sys/stat.h>
#include <ctype.h>
#include <errno.h>

#define MAX_PATH 4096
#define MAX_NAME 256

/* Read the contents of a small procfs file into buf. Returns bytes read or -1. */
static int read_proc_file(const char *path, char *buf, size_t bufsz) {
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    size_t n = fread(buf, 1, bufsz - 1, f);
    buf[n] = '\0';
    fclose(f);
    return (int)n;
}

/* Get the command name for a pid from /proc/<pid>/cmdline. */
static void get_command(int pid, char *out, size_t outsz) {
    char path[MAX_PATH];
    char buf[MAX_PATH];
    snprintf(path, sizeof(path), "/proc/%d/cmdline", pid);
    int n = read_proc_file(path, buf, sizeof(buf));
    if (n <= 0) {
        snprintf(out, outsz, "?");
        return;
    }
    /* cmdline is null-separated; take basename of first arg */
    const char *slash = strrchr(buf, '/');
    const char *name = slash ? slash + 1 : buf;
    snprintf(out, outsz, "%.*s", (int)(outsz - 1), name);
}

/* Get fd type string from the readlink target. */
static const char *fd_type(const char *link) {
    struct stat st;
    if (stat(link, &st) == 0) {
        if (S_ISREG(st.st_mode))  return "REG";
        if (S_ISDIR(st.st_mode))  return "DIR";
        if (S_ISCHR(st.st_mode))  return "CHR";
        if (S_ISBLK(st.st_mode))  return "BLK";
        if (S_ISFIFO(st.st_mode)) return "FIFO";
        if (S_ISSOCK(st.st_mode)) return "sock";
    }
    if (strncmp(link, "pipe:", 5) == 0) return "FIFO";
    if (strncmp(link, "socket:", 7) == 0) return "sock";
    return "unknown";
}

/* List open files for a single pid. Returns number of fds printed. */
static int list_pid(int pid, const char *filter_file) {
    char fd_dir[MAX_PATH];
    char cmd[MAX_NAME];
    int count = 0;

    get_command(pid, cmd, sizeof(cmd));

    snprintf(fd_dir, sizeof(fd_dir), "/proc/%d/fd", pid);
    DIR *dir = opendir(fd_dir);
    if (!dir) return 0;

    struct dirent *de;
    while ((de = readdir(dir)) != NULL) {
        if (de->d_name[0] == '.') continue;
        int fd = atoi(de->d_name);

        char link_path[MAX_PATH];
        char target[MAX_PATH];
        snprintf(link_path, sizeof(link_path), "/proc/%d/fd/%d", pid, fd);
        ssize_t len = readlink(link_path, target, sizeof(target) - 1);
        if (len < 0) continue;
        target[len] = '\0';

        /* If filtering by file, skip non-matching entries */
        if (filter_file && strcmp(target, filter_file) != 0) continue;

        const char *type = fd_type(target);
        printf("%-10s %5d %4d %7s %s\n", cmd, pid, fd, type, target);
        count++;
    }
    closedir(dir);
    return count;
}

/* Iterate /proc and list open files for all (or filtered) processes. */
static int list_all(int filter_pid, const char *filter_cmd, const char *filter_file) {
    DIR *proc_dir = opendir("/proc");
    if (!proc_dir) {
        fprintf(stderr, "lsof: cannot open /proc: %s\n", strerror(errno));
        return 1;
    }

    printf("%-10s %5s %4s %7s %s\n", "COMMAND", "PID", "FD", "TYPE", "NAME");

    struct dirent *de;
    while ((de = readdir(proc_dir)) != NULL) {
        /* Only look at numeric entries (PIDs) */
        if (!isdigit((unsigned char)de->d_name[0])) continue;
        int pid = atoi(de->d_name);
        if (pid <= 0) continue;

        if (filter_pid > 0 && pid != filter_pid) continue;

        if (filter_cmd) {
            char cmd[MAX_NAME];
            get_command(pid, cmd, sizeof(cmd));
            if (strstr(cmd, filter_cmd) == NULL) continue;
        }

        list_pid(pid, filter_file);
    }
    closedir(proc_dir);
    return 0;
}

int main(int argc, char *argv[]) {
    int filter_pid = -1;
    const char *filter_cmd = NULL;
    const char *filter_file = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-p") == 0 && i + 1 < argc) {
            filter_pid = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-c") == 0 && i + 1 < argc) {
            filter_cmd = argv[++i];
        } else if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
            printf("Usage: lsof [-p pid] [-c command] [file]\n");
            return 0;
        } else if (argv[i][0] != '-') {
            filter_file = argv[i];
        } else {
            fprintf(stderr, "lsof: unknown option: %s\n", argv[i]);
            return 1;
        }
    }

    return list_all(filter_pid, filter_cmd, filter_file);
}
