/*
 * End-to-end guest regression for Kandelo's intentionally limited Linux
 * procfs resource-accounting surface.
 *
 * The values checked here are platform contracts, not host-machine metrics:
 * Kandelo exposes the process's logical Wasm address-space size, while CPU,
 * residency, and machine-wide memory accounting remain unavailable and are
 * reported as zero.  Keeping the assertions in a guest program exercises the
 * SDK/libc, syscall channel, kernel procfs implementation, and directory/stat
 * marshalling together.
 */

#include <dirent.h>
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int failures;
extern char **environ;

static void fail_check(const char *check, const char *detail) {
    fprintf(stderr, "FAIL %s: %s\n", check, detail);
    failures++;
}

static int read_text_file(const char *path, char *buf, size_t capacity) {
    FILE *file;
    size_t used;

    if (capacity < 2) {
        fail_check(path, "test buffer is too small");
        return -1;
    }

    file = fopen(path, "r");
    if (file == NULL) {
        char detail[96];
        snprintf(detail, sizeof(detail), "fopen failed with errno=%d", errno);
        fail_check(path, detail);
        return -1;
    }

    used = fread(buf, 1, capacity - 1, file);
    if (ferror(file)) {
        char detail[96];
        snprintf(detail, sizeof(detail), "fread failed with errno=%d", errno);
        fail_check(path, detail);
        fclose(file);
        return -1;
    }
    if (used == capacity - 1 && fgetc(file) != EOF) {
        fail_check(path, "content exceeds the test buffer");
        fclose(file);
        return -1;
    }
    if (fclose(file) != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "fclose failed with errno=%d", errno);
        fail_check(path, detail);
        return -1;
    }

    buf[used] = '\0';
    return 0;
}

static int owner_matches_effective_ids(const char *path, struct stat *out) {
    struct stat st;

    if (stat(path, &st) != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "stat failed with errno=%d", errno);
        fail_check(path, detail);
        return 0;
    }
    if (st.st_uid != geteuid() || st.st_gid != getegid()) {
        char detail[160];
        snprintf(detail, sizeof(detail),
                 "owner=%lu:%lu effective=%lu:%lu",
                 (unsigned long)st.st_uid, (unsigned long)st.st_gid,
                 (unsigned long)geteuid(), (unsigned long)getegid());
        fail_check(path, detail);
        return 0;
    }
    if (out != NULL) {
        *out = st;
    }
    return 1;
}

static int drop_to_demo_user(void) {
    if (geteuid() != 0 || getegid() != 0) {
        fail_check("identity", "fixture did not start as root");
        return -1;
    }
    /* Drop the group first; after setuid the process must not retain a path
     * back to privileged group credentials. */
    if (setgid(1000) != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "setgid(1000) failed with errno=%d", errno);
        fail_check("identity", detail);
        return -1;
    }
    if (setuid(1000) != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "setuid(1000) failed with errno=%d", errno);
        fail_check("identity", detail);
        return -1;
    }
    if (geteuid() != 1000 || getegid() != 1000) {
        char detail[128];
        snprintf(detail, sizeof(detail), "effective identity is %lu:%lu",
                 (unsigned long)geteuid(), (unsigned long)getegid());
        fail_check("identity", detail);
        return -1;
    }
    puts("IDENTITY euid=1000 egid=1000");
    return 0;
}

static void check_proc_enumeration(void) {
    DIR *dir;
    struct dirent *entry;
    char pid_name[32];
    int saw_stat = 0;
    int saw_meminfo = 0;
    int saw_pid = 0;

    snprintf(pid_name, sizeof(pid_name), "%ld", (long)getpid());
    dir = opendir("/proc");
    if (dir == NULL) {
        char detail[96];
        snprintf(detail, sizeof(detail), "opendir failed with errno=%d", errno);
        fail_check("/proc enumeration", detail);
        return;
    }

    errno = 0;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, "stat") == 0) saw_stat = 1;
        if (strcmp(entry->d_name, "meminfo") == 0) saw_meminfo = 1;
        if (strcmp(entry->d_name, pid_name) == 0) saw_pid = 1;
    }
    if (errno != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "readdir failed with errno=%d", errno);
        fail_check("/proc enumeration", detail);
    }
    if (closedir(dir) != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "closedir failed with errno=%d", errno);
        fail_check("/proc enumeration", detail);
    }

    if (!saw_stat) fail_check("/proc enumeration", "missing stat");
    if (!saw_meminfo) fail_check("/proc enumeration", "missing meminfo");
    if (!saw_pid) fail_check("/proc enumeration", "missing current PID directory");
    if (saw_stat && saw_meminfo && saw_pid) {
        printf("PROC enumeration stat=1 meminfo=1 self_pid=1\n");
    }
}

static int read_and_check_statm(const char *path, unsigned long long *size_pages) {
    char text[512];
    char extra[2];
    unsigned long long fields[7];
    int parsed;
    int unsupported_zero = 1;
    int i;

    if (read_text_file(path, text, sizeof(text)) != 0) return 0;
    parsed = sscanf(text, "%llu %llu %llu %llu %llu %llu %llu %1s",
                    &fields[0], &fields[1], &fields[2], &fields[3],
                    &fields[4], &fields[5], &fields[6], extra);
    if (parsed != 7) {
        char detail[96];
        snprintf(detail, sizeof(detail), "expected 7 fields, parsed %d", parsed);
        fail_check(path, detail);
        return 0;
    }
    if (fields[0] == 0) {
        fail_check(path, "logical size field is zero");
    }
    for (i = 1; i < 7; i++) {
        if (fields[i] != 0) unsupported_zero = 0;
    }
    if (!unsupported_zero) {
        fail_check(path, "unsupported fields are not all zero");
    }
    if (fields[0] == 0 || !unsupported_zero) return 0;
    if (size_pages != NULL) {
        *size_pages = fields[0];
    }
    return 1;
}

static void check_statm(void) {
    unsigned long long size_pages;

    if (read_and_check_statm("/proc/self/statm", &size_pages)) {
        printf("STATM size_pages=%llu unsupported_fields_zero=1\n", size_pages);
    }
}

static void check_task_directory(void) {
    DIR *dir;
    struct dirent *entry;
    struct stat st;
    char main_tid[32];
    int saw_main = 0;
    int owner_ok;

    snprintf(main_tid, sizeof(main_tid), "%ld", (long)getpid());
    dir = opendir("/proc/self/task");
    if (dir == NULL) {
        char detail[96];
        snprintf(detail, sizeof(detail), "opendir failed with errno=%d", errno);
        fail_check("/proc/self/task", detail);
        return;
    }

    errno = 0;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, main_tid) == 0) saw_main = 1;
    }
    if (errno != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "readdir failed with errno=%d", errno);
        fail_check("/proc/self/task", detail);
    }
    if (closedir(dir) != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "closedir failed with errno=%d", errno);
        fail_check("/proc/self/task", detail);
    }
    if (!saw_main) {
        fail_check("/proc/self/task", "main TID is absent");
    }

    owner_ok = owner_matches_effective_ids("/proc/self/task", &st);
    if (saw_main && owner_ok) {
        printf("TASK main_tid=%s owner=%lu:%lu\n", main_tid,
               (unsigned long)st.st_uid, (unsigned long)st.st_gid);
    }
}

static void check_process_stat(void) {
    char text[4096];
    char *cursor;
    char *comm_end;
    char *end;
    long long nice_value = 0;
    long long vsize = 0;
    long long rss = 0;
    int field;
    int expected_nice;
    int parsed_through_rss = 1;
    int owner_ok;
    struct stat st;

    /* A non-zero value catches field-shift and hard-coded-zero mistakes. */
    if (setpriority(PRIO_PROCESS, 0, 7) != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "setpriority failed with errno=%d", errno);
        fail_check("nice accounting", detail);
        return;
    }
    errno = 0;
    expected_nice = getpriority(PRIO_PROCESS, 0);
    if (expected_nice == -1 && errno != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "getpriority failed with errno=%d", errno);
        fail_check("nice accounting", detail);
        return;
    }
    if (expected_nice != 7) {
        char detail[96];
        snprintf(detail, sizeof(detail), "expected nice=7, got %d", expected_nice);
        fail_check("nice accounting", detail);
        return;
    }

    if (read_text_file("/proc/self/stat", text, sizeof(text)) != 0) return;
    comm_end = strrchr(text, ')');
    if (comm_end == NULL) {
        fail_check("/proc/self/stat", "missing closing comm parenthesis");
        return;
    }

    cursor = comm_end + 1;
    for (field = 3; field <= 24; field++) {
        while (*cursor == ' ' || *cursor == '\t') cursor++;
        if (*cursor == '\0' || *cursor == '\n') {
            parsed_through_rss = 0;
            break;
        }
        if (field == 3) {
            /* State is the only non-numeric field after comm. */
            while (*cursor != '\0' && *cursor != '\n' &&
                   *cursor != ' ' && *cursor != '\t') {
                cursor++;
            }
            continue;
        }

        errno = 0;
        end = NULL;
        {
            long long value = strtoll(cursor, &end, 10);
            if (end == cursor || errno == ERANGE) {
                parsed_through_rss = 0;
                break;
            }
            if (field == 19) nice_value = value;
            if (field == 23) vsize = value;
            if (field == 24) rss = value;
        }
        cursor = end;
    }

    if (!parsed_through_rss) {
        fail_check("/proc/self/stat", "could not parse through field 24");
        return;
    }
    if (nice_value != expected_nice) {
        char detail[96];
        snprintf(detail, sizeof(detail), "field19=%lld expected=%d",
                 nice_value, expected_nice);
        fail_check("/proc/self/stat", detail);
    }
    if (vsize <= 0) {
        fail_check("/proc/self/stat", "field23 vsize is not positive");
    }
    if (rss != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "field24 rss=%lld expected=0", rss);
        fail_check("/proc/self/stat", detail);
    }

    owner_ok = owner_matches_effective_ids("/proc/self/stat", &st);
    if (nice_value == expected_nice && vsize > 0 && rss == 0 && owner_ok) {
        printf("STAT nice=%lld vsize_bytes=%lld rss_pages=0 owner=%lu:%lu\n",
               nice_value, vsize, (unsigned long)st.st_uid,
               (unsigned long)st.st_gid);
    }
}

static void check_cpu_stat(void) {
    char text[2048];
    char *save = NULL;
    char *token;
    int fields = 0;
    int all_zero = 1;

    if (read_text_file("/proc/stat", text, sizeof(text)) != 0) return;
    token = strtok_r(text, " \t\r\n", &save);
    if (token == NULL || strcmp(token, "cpu") != 0) {
        fail_check("/proc/stat", "first record is not aggregate cpu");
        return;
    }

    while ((token = strtok_r(NULL, " \t\r\n", &save)) != NULL) {
        char *end = NULL;
        unsigned long long value;

        errno = 0;
        value = strtoull(token, &end, 10);
        if (end == token || *end != '\0' || errno == ERANGE) {
            /* A later non-numeric record marks the end of the first line. */
            break;
        }
        fields++;
        if (value != 0) all_zero = 0;
    }

    if (fields < 4) {
        fail_check("/proc/stat", "aggregate cpu record has fewer than 4 fields");
    }
    if (!all_zero) {
        fail_check("/proc/stat", "aggregate cpu fields are not all zero");
    }
    if (fields >= 4 && all_zero) {
        printf("CPU aggregate_fields=%d all_zero=1\n", fields);
    }
}

static void check_meminfo(void) {
    static const char *required[] = {
        "MemTotal", "MemFree", "Cached", "SReclaimable", "Buffers"
    };
    char text[2048];
    char *save = NULL;
    char *line;
    int seen[sizeof(required) / sizeof(required[0])] = {0};
    int all_zero = 1;
    size_t i;

    if (read_text_file("/proc/meminfo", text, sizeof(text)) != 0) return;
    for (line = strtok_r(text, "\n", &save); line != NULL;
         line = strtok_r(NULL, "\n", &save)) {
        char key[64];
        unsigned long long value;

        if (sscanf(line, " %63[^:]: %llu", key, &value) != 2) continue;
        for (i = 0; i < sizeof(required) / sizeof(required[0]); i++) {
            if (strcmp(key, required[i]) != 0) continue;
            seen[i] = 1;
            if (value != 0) {
                char detail[128];
                all_zero = 0;
                snprintf(detail, sizeof(detail), "%s=%llu expected=0", key, value);
                fail_check("/proc/meminfo", detail);
            }
        }
    }

    for (i = 0; i < sizeof(required) / sizeof(required[0]); i++) {
        if (!seen[i]) {
            char detail[96];
            snprintf(detail, sizeof(detail), "missing %s", required[i]);
            fail_check("/proc/meminfo", detail);
        }
    }
    if (seen[0] && seen[1] && seen[2] && seen[3] && seen[4] && all_zero) {
        printf("MEMINFO required_fields=5 all_zero=1\n");
    }
}

static void check_processor_count(void) {
    long online = sysconf(_SC_NPROCESSORS_ONLN);
    long configured = sysconf(_SC_NPROCESSORS_CONF);

    if (online != 1) {
        char detail[96];
        snprintf(detail, sizeof(detail), "online=%ld expected=1 errno=%d", online, errno);
        fail_check("sysconf processors", detail);
    }
    if (configured != 1) {
        char detail[96];
        snprintf(detail, sizeof(detail), "configured=%ld expected=1 errno=%d",
                 configured, errno);
        fail_check("sysconf processors", detail);
    }
    if (online == 1 && configured == 1) {
        printf("NPROCESSORS online=1 configured=1\n");
    }
}

static int blocked_child_main(const char *fd_text) {
    char *end = NULL;
    long fd_long;
    char byte;
    ssize_t count;

    errno = 0;
    fd_long = strtol(fd_text, &end, 10);
    if (end == fd_text || *end != '\0' || errno == ERANGE ||
        fd_long < 0 || fd_long > 1023) {
        fprintf(stderr, "blocked child: invalid fd %s\n", fd_text);
        return 2;
    }
    if (geteuid() != 1000 || getegid() != 1000) {
        fprintf(stderr, "blocked child: identity=%lu:%lu expected=1000:1000\n",
                (unsigned long)geteuid(), (unsigned long)getegid());
        return 3;
    }

    do {
        count = read((int)fd_long, &byte, 1);
    } while (count < 0 && errno == EINTR);
    if (count != 1) {
        fprintf(stderr, "blocked child: read returned %ld errno=%d\n",
                (long)count, errno);
        return 4;
    }
    return 0;
}

static int spawn_blocked_child(pid_t *child_pid, int *release_fd) {
    static const char *child_path = "/usr/bin/procfs-accounting-test";
    int pipe_fds[2];
    char read_fd_text[32];
    char *child_argv[4];
    int rc;

    if (pipe(pipe_fds) != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "pipe failed with errno=%d", errno);
        fail_check("foreign procfs", detail);
        return -1;
    }
    snprintf(read_fd_text, sizeof(read_fd_text), "%d", pipe_fds[0]);
    child_argv[0] = (char *)"procfs_accounting_test";
    child_argv[1] = (char *)"--blocked-child";
    child_argv[2] = read_fd_text;
    child_argv[3] = NULL;

    rc = posix_spawn(child_pid, child_path, NULL, NULL, child_argv, environ);
    if (rc != 0) {
        char detail[128];
        snprintf(detail, sizeof(detail), "posix_spawn failed with rc=%d", rc);
        fail_check("foreign procfs", detail);
        close(pipe_fds[0]);
        close(pipe_fds[1]);
        return -1;
    }

    close(pipe_fds[0]);
    *release_fd = pipe_fds[1];
    return 0;
}

static void check_foreign_process(void) {
    pid_t child_pid;
    int release_fd;
    char stat_path[64];
    char statm_path[64];
    char task_path[64];
    char child_name[32];
    char stat_text[4096];
    struct stat stat_st;
    struct stat task_st;
    DIR *task_dir = NULL;
    struct dirent *entry;
    unsigned long long statm_pages = 0;
    int stat_owner_ok;
    int task_owner_ok;
    int stat_pid_ok = 0;
    int main_tid_seen = 0;
    int status;
    char release = 'x';

    if (spawn_blocked_child(&child_pid, &release_fd) != 0) return;

    snprintf(child_name, sizeof(child_name), "%ld", (long)child_pid);
    snprintf(stat_path, sizeof(stat_path), "/proc/%ld/stat", (long)child_pid);
    snprintf(statm_path, sizeof(statm_path), "/proc/%ld/statm", (long)child_pid);
    snprintf(task_path, sizeof(task_path), "/proc/%ld/task", (long)child_pid);

    stat_owner_ok = owner_matches_effective_ids(stat_path, &stat_st);
    task_owner_ok = owner_matches_effective_ids(task_path, &task_st);

    if (read_text_file(stat_path, stat_text, sizeof(stat_text)) == 0) {
        char *end = NULL;
        long reported_pid;

        errno = 0;
        reported_pid = strtol(stat_text, &end, 10);
        if (end == stat_text || errno == ERANGE || reported_pid != (long)child_pid) {
            fail_check("foreign /proc/<pid>/stat", "field1 does not match child PID");
        } else {
            stat_pid_ok = 1;
        }
    }
    (void)read_and_check_statm(statm_path, &statm_pages);

    task_dir = opendir(task_path);
    if (task_dir == NULL) {
        char detail[96];
        snprintf(detail, sizeof(detail), "opendir failed with errno=%d", errno);
        fail_check("foreign /proc/<pid>/task", detail);
    } else {
        errno = 0;
        while ((entry = readdir(task_dir)) != NULL) {
            if (strcmp(entry->d_name, child_name) == 0) main_tid_seen = 1;
        }
        if (errno != 0) {
            char detail[96];
            snprintf(detail, sizeof(detail), "readdir failed with errno=%d", errno);
            fail_check("foreign /proc/<pid>/task", detail);
        }
        if (closedir(task_dir) != 0) {
            char detail[96];
            snprintf(detail, sizeof(detail), "closedir failed with errno=%d", errno);
            fail_check("foreign /proc/<pid>/task", detail);
        }
        if (!main_tid_seen) {
            fail_check("foreign /proc/<pid>/task", "child main TID is absent");
        }
    }

    if (stat_owner_ok && task_owner_ok && stat_pid_ok &&
        statm_pages > 0 && main_tid_seen) {
        printf("FOREIGN pid=%ld owner=%lu:%lu statm_pages=%llu main_tid=1\n",
               (long)child_pid, (unsigned long)stat_st.st_uid,
               (unsigned long)stat_st.st_gid, statm_pages);
    }

    if (write(release_fd, &release, 1) != 1) {
        char detail[96];
        snprintf(detail, sizeof(detail), "release write failed with errno=%d", errno);
        fail_check("foreign procfs", detail);
    }
    close(release_fd);
    if (waitpid(child_pid, &status, 0) != child_pid) {
        char detail[96];
        snprintf(detail, sizeof(detail), "waitpid failed with errno=%d", errno);
        fail_check("foreign procfs", detail);
    } else if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        char detail[96];
        snprintf(detail, sizeof(detail), "child status=0x%x", status);
        fail_check("foreign procfs", detail);
    }
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "--blocked-child") == 0) {
        return blocked_child_main(argv[2]);
    }
    if (drop_to_demo_user() != 0) return 1;

    check_proc_enumeration();
    check_statm();
    check_task_directory();
    check_process_stat();
    check_cpu_stat();
    check_meminfo();
    check_processor_count();
    check_foreign_process();

    if (failures != 0) {
        fprintf(stderr, "FAIL procfs_accounting_test failures=%d\n", failures);
        return 1;
    }
    puts("PASS procfs_accounting_test");
    return 0;
}
