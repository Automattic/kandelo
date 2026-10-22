/*
 * Orphan adoption by init.
 *
 * POSIX gives every child of a terminated process a new parent, the
 * implementation-defined system process. On Kandelo that is synthetic init
 * (PID 1). Init runs no wait loop, so the kernel reaps the children it
 * adopts. This program checks three cases through the normal fork/wait path:
 *
 *   1. A double-fork daemon: the grandchild observes getppid() == 1 after
 *      its parent exits, and init reaps it after it exits.
 *   2. A grandchild that is already a zombie when its parent exits is
 *      reaped by init at adoption.
 *   3. A process group left orphaned with a stopped member receives SIGHUP
 *      followed by SIGCONT. A member that catches SIGHUP reports it; a
 *      member with the default action is terminated and reaped by init.
 *
 * Zombies stay visible under /proc until reaped, so the absence of
 * /proc/<pid> shows that init reaped a process.
 *
 * With --hold, the program prints the adopted PIDs and then waits for
 * stdin to close, so a host test can inspect the kernel process table.
 */
#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define WAIT_STEPS 1000

static void pause_briefly(void)
{
    struct timespec delay = {0, 10 * 1000 * 1000};
    nanosleep(&delay, NULL);
}

static int fail(const char *step)
{
    fprintf(stderr, "FAIL %s: errno=%d (%s)\n", step, errno, strerror(errno));
    return 1;
}

static int proc_entry_exists(pid_t pid)
{
    char path[32];
    struct stat st;
    snprintf(path, sizeof path, "/proc/%d", (int)pid);
    return stat(path, &st) == 0;
}

/* Wait until init has reaped `pid`, whose status this process cannot take. */
static int wait_for_init_reap(pid_t pid, const char *label)
{
    if (waitpid(pid, NULL, WNOHANG) != -1 || errno != ECHILD) {
        fprintf(stderr, "FAIL %s: pid %d is waitable by its former grandparent\n",
                label, (int)pid);
        return 1;
    }
    for (int step = 0; step < WAIT_STEPS; step++) {
        if (!proc_entry_exists(pid)) return 0;
        pause_briefly();
    }
    fprintf(stderr, "FAIL %s: pid %d was never reaped\n", label, (int)pid);
    return 1;
}

static char proc_state(const char *pid_name)
{
    char path[64];
    char buf[256];
    snprintf(path, sizeof path, "/proc/%s/stat", pid_name);
    FILE *file = fopen(path, "r");
    if (!file) return 0;
    size_t len = fread(buf, 1, sizeof buf - 1, file);
    fclose(file);
    buf[len] = '\0';
    /* pid (comm) state ...: comm may contain spaces, so use the last ')'. */
    char *close_paren = strrchr(buf, ')');
    return close_paren && close_paren[1] == ' ' ? close_paren[2] : 0;
}

/* No process anywhere in the machine may be left a zombie. */
static int check_no_zombies(void)
{
    DIR *proc = opendir("/proc");
    if (!proc) return fail("opendir /proc");
    int zombies = 0;
    struct dirent *entry;
    while ((entry = readdir(proc)) != NULL) {
        if (entry->d_name[0] < '1' || entry->d_name[0] > '9') continue;
        if (proc_state(entry->d_name) == 'Z') {
            fprintf(stderr, "FAIL zombie remains: pid %s\n", entry->d_name);
            zombies++;
        }
    }
    closedir(proc);
    return zombies != 0;
}

struct adoption_report {
    pid_t pid;
    pid_t ppid;
};

/* Case 1: the grandchild outlives its parent and is adopted while live. */
static int double_fork_daemon(pid_t *grandchild_out)
{
    int report[2];
    if (pipe(report) != 0) return fail("pipe");

    pid_t middle = fork();
    if (middle < 0) return fail("fork middle");
    if (middle == 0) {
        pid_t grandchild = fork();
        if (grandchild == 0) {
            close(report[0]);
            for (int step = 0; step < WAIT_STEPS && getppid() != 1; step++) {
                pause_briefly();
            }
            struct adoption_report observed = {getpid(), getppid()};
            if (write(report[1], &observed, sizeof observed) != sizeof observed) {
                _exit(3);
            }
            _exit(0);
        }
        _exit(grandchild < 0 ? 2 : 0);
    }
    close(report[1]);

    int status = 0;
    if (waitpid(middle, &status, 0) != middle) return fail("waitpid middle");
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "FAIL middle status 0x%x\n", status);
        return 1;
    }

    struct adoption_report observed;
    if (read(report[0], &observed, sizeof observed) != sizeof observed) {
        return fail("read adoption report");
    }
    char extra;
    if (read(report[0], &extra, 1) != 0) return fail("grandchild exit EOF");
    close(report[0]);

    if (observed.ppid != 1) {
        fprintf(stderr, "FAIL grandchild %d saw getppid()=%d, expected 1\n",
                (int)observed.pid, (int)observed.ppid);
        return 1;
    }
    printf("DAEMON_GRANDCHILD %d PPID %d\n", (int)observed.pid, (int)observed.ppid);
    *grandchild_out = observed.pid;
    return wait_for_init_reap(observed.pid, "daemon grandchild");
}

/* Case 2: the grandchild is already a zombie when its parent exits. */
static int zombie_adoption(pid_t *grandchild_out)
{
    int report[2];
    if (pipe(report) != 0) return fail("pipe");

    pid_t middle = fork();
    if (middle < 0) return fail("fork middle");
    if (middle == 0) {
        pid_t grandchild = fork();
        if (grandchild == 0) _exit(0);
        if (grandchild < 0) _exit(2);
        char pid_name[16];
        snprintf(pid_name, sizeof pid_name, "%d", (int)grandchild);
        int step = 0;
        while (step < WAIT_STEPS && proc_state(pid_name) != 'Z') {
            pause_briefly();
            step++;
        }
        if (step == WAIT_STEPS) _exit(4);
        if (write(report[1], &grandchild, sizeof grandchild) != sizeof grandchild) {
            _exit(3);
        }
        /* Exit without waiting: the zombie is handed to init. */
        _exit(0);
    }
    close(report[1]);

    pid_t grandchild;
    if (read(report[0], &grandchild, sizeof grandchild) != sizeof grandchild) {
        return fail("read zombie pid");
    }
    close(report[0]);
    int status = 0;
    if (waitpid(middle, &status, 0) != middle) return fail("waitpid middle");
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "FAIL zombie middle status 0x%x\n", status);
        return 1;
    }
    printf("ZOMBIE_GRANDCHILD %d\n", (int)grandchild);
    *grandchild_out = grandchild;
    return wait_for_init_reap(grandchild, "zombie grandchild");
}

static int hup_pipe = -1;

static void on_sighup(int signum)
{
    (void)signum;
    char byte = 'H';
    (void)write(hup_pipe, &byte, 1);
    _exit(0);
}

/* Fork one member of the caller's process group and stop it. */
static pid_t fork_stopped_member(int catch_sighup, int report_fd)
{
    pid_t member = fork();
    if (member != 0) return member;
    if (catch_sighup) {
        hup_pipe = report_fd;
        struct sigaction action;
        memset(&action, 0, sizeof action);
        action.sa_handler = on_sighup;
        sigemptyset(&action.sa_mask);
        if (sigaction(SIGHUP, &action, NULL) != 0) _exit(3);
        raise(SIGSTOP);
        /* Resumed without SIGHUP. */
        char byte = 'C';
        (void)write(report_fd, &byte, 1);
        _exit(4);
    }
    close(report_fd);
    raise(SIGSTOP);
    /* The default SIGHUP action must terminate this member. */
    for (;;) pause();
}

/*
 * Case 3: a newly orphaned group with a stopped member gets SIGHUP and
 * SIGCONT. One member catches SIGHUP and reports it; the other keeps the
 * default action and must be terminated by it, then reaped by init.
 */
static int orphaned_stopped_group(pid_t *default_member_out)
{
    int report[2];
    int pids[2];
    if (pipe(report) != 0 || pipe(pids) != 0) return fail("pipe");

    pid_t leader = fork();
    if (leader < 0) return fail("fork leader");
    if (leader == 0) {
        close(report[0]);
        close(pids[0]);
        /* A new group in this session: this process links it to the
         * session through its parent, which stays in another group. */
        if (setpgid(0, 0) != 0) _exit(2);
        pid_t members[2] = {
            fork_stopped_member(1, report[1]),
            fork_stopped_member(0, report[1]),
        };
        for (int i = 0; i < 2; i++) {
            int status = 0;
            if (members[i] < 0) _exit(5);
            if (waitpid(members[i], &status, WUNTRACED) != members[i]
                || !WIFSTOPPED(status)) {
                _exit(6);
            }
        }
        if (write(pids[1], &members[1], sizeof members[1]) != sizeof members[1]) {
            _exit(7);
        }
        /* Exiting orphans the group while both members are stopped. */
        _exit(0);
    }
    close(report[1]);
    close(pids[1]);

    int status = 0;
    if (waitpid(leader, &status, 0) != leader) return fail("waitpid leader");
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "FAIL group leader status 0x%x\n", status);
        return 1;
    }
    pid_t default_member;
    if (read(pids[0], &default_member, sizeof default_member)
        != sizeof default_member) {
        return fail("read default member pid");
    }
    close(pids[0]);
    char byte = 0;
    ssize_t got = read(report[0], &byte, 1);
    close(report[0]);
    if (got != 1 || byte != 'H') {
        fprintf(stderr,
                "FAIL stopped member of orphaned group got no SIGHUP (%s)\n",
                got == 1 && byte == 'C' ? "resumed without it" : "never resumed");
        return 1;
    }
    printf("ORPHANED_GROUP_SIGHUP\n");
    *default_member_out = default_member;
    return wait_for_init_reap(default_member, "default-SIGHUP member");
}

static const char *volatile stage = "start";

static void on_timeout(int signum)
{
    (void)signum;
    static const char prefix[] = "FAIL timed out in ";
    (void)write(STDERR_FILENO, prefix, sizeof prefix - 1);
    (void)write(STDERR_FILENO, stage, strlen(stage));
    (void)write(STDERR_FILENO, "\n", 1);
    _exit(1);
}

int main(int argc, char **argv)
{
    int hold = argc > 1 && strcmp(argv[1], "--hold") == 0;
    /* Each result line reaches the host as soon as it is known. Children
     * flush nothing: they inherit an empty buffer. */
    setvbuf(stdout, NULL, _IOLBF, 0);
    pid_t daemon_grandchild = 0;
    pid_t zombie_grandchild = 0;
    pid_t hung_up_member = 0;

    /* A missing wakeup reports where it stalled instead of hanging. Forked
     * children do not inherit the alarm. */
    signal(SIGALRM, on_timeout);
    alarm(60);
    stage = "double-fork daemon";
    if (double_fork_daemon(&daemon_grandchild) != 0) return 1;
    stage = "zombie adoption";
    if (zombie_adoption(&zombie_grandchild) != 0) return 1;
    stage = "orphaned stopped group";
    if (orphaned_stopped_group(&hung_up_member) != 0) return 1;
    stage = "zombie scan";
    if (check_no_zombies() != 0) return 1;
    alarm(0);

    printf("PASS: ORPHAN_REPARENT\n");
    if (hold) {
        printf("HOLD %d %d %d\n", (int)daemon_grandchild, (int)zombie_grandchild,
               (int)hung_up_member);
        fflush(stdout);
        char drain;
        while (read(STDIN_FILENO, &drain, 1) > 0) {
        }
    }
    return 0;
}
