/*
 * End-to-end vfork process-state coverage.
 *
 * The child borrows only the parent's address space. Its descriptor table,
 * cwd, credentials, and process-group membership remain independent Process
 * state, while inherited descriptors continue to reference the same open file
 * description (OFD).
 */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stddef.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void marker(const char *text, size_t length) {
    while (length > 0) {
        ssize_t written = write(STDOUT_FILENO, text, length);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) _exit(120);
        text += written;
        length -= (size_t)written;
    }
}

#define MARKER(text) marker(text, sizeof(text) - 1)

static void parent_signal_handler(int signal_number) {
    (void)signal_number;
}

int main(void) {
    static const char contents[] = "abcdef";
    char cwd[64];
    char byte = '\0';
    int status = 0;
    struct sigaction parent_action;
    struct sigaction observed_action;
    sigset_t blocked_mask;
    sigset_t original_mask;
    sigset_t observed_mask;

    memset(&parent_action, 0, sizeof(parent_action));
    parent_action.sa_handler = parent_signal_handler;
    if (sigemptyset(&parent_action.sa_mask) != 0) return 1;
    if (sigaction(SIGUSR1, &parent_action, NULL) != 0) return 2;
    if (sigemptyset(&blocked_mask) != 0) return 3;
    if (sigaddset(&blocked_mask, SIGUSR1) != 0) return 4;
    if (sigprocmask(SIG_BLOCK, &blocked_mask, &original_mask) != 0) return 5;

    if (getuid() != 0 || geteuid() != 0) return 6;
    if (getgid() != 0 || getegid() != 0) return 7;
    if (mkdir("/tmp/vfork-parent", 0755) != 0 && errno != EEXIST) return 8;
    if (chdir("/tmp/vfork-parent") != 0) return 9;

    int fd = open("ofd-state", O_CREAT | O_TRUNC | O_RDWR, 0644);
    if (fd < 0) return 10;
    if (write(fd, contents, sizeof(contents) - 1) != sizeof(contents) - 1) {
        return 11;
    }
    if (lseek(fd, 0, SEEK_SET) != 0) return 12;
    if (fcntl(fd, F_GETFD) != 0) return 13;

    pid_t parent_pid = getpid();
    pid_t parent_ppid = getppid();
    pid_t parent_pgrp = getpgrp();
    pid_t parent_sid = getsid(0);
    if (parent_pid <= 0 || parent_ppid < 0 || parent_pgrp <= 0 ||
        parent_sid < 0) {
        return 14;
    }

    pid_t pid = vfork();
    if (pid < 0) return 15;
    if (pid == 0) {
        if (getuid() != 0 || getgid() != 0) _exit(21);
        if (getpgrp() != parent_pgrp) _exit(22);
        if (getsid(0) != parent_sid) _exit(23);
        if (getppid() != parent_pid) _exit(24);
        if (sigaction(SIGUSR1, NULL, &observed_action) != 0) _exit(25);
        if (observed_action.sa_handler != parent_signal_handler) _exit(26);
        if (sigprocmask(SIG_SETMASK, NULL, &observed_mask) != 0) _exit(27);
        if (sigismember(&observed_mask, SIGUSR1) != 1) _exit(28);
        MARKER("CHILD_INHERITED_POSIX_STATE\n");

        if (lseek(fd, 2, SEEK_SET) != 2) _exit(29);
        if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0) _exit(30);
        if (lseek(fd, 0, SEEK_CUR) != 2) _exit(31);
        if (fcntl(fd, F_GETFD) != FD_CLOEXEC) _exit(32);
        if (close(fd) != 0) _exit(33);
        if (chdir("/") != 0) _exit(34);
        if (getcwd(cwd, sizeof(cwd)) == NULL || strcmp(cwd, "/") != 0) {
            _exit(35);
        }
        if (setpgid(0, 0) != 0) _exit(36);
        if (getpgrp() != getpid() || getpgid(0) != getpid()) _exit(37);
        if (getppid() != parent_pid || getsid(0) != parent_sid) _exit(38);
        if (setgid(1234) != 0) _exit(39);
        if (getgid() != 1234 || getegid() != 1234) _exit(40);
        if (setuid(1234) != 0) _exit(41);
        if (getuid() != 1234 || geteuid() != 1234) _exit(42);

        memset(&observed_action, 0, sizeof(observed_action));
        observed_action.sa_handler = SIG_IGN;
        if (sigemptyset(&observed_action.sa_mask) != 0) _exit(43);
        if (sigaction(SIGUSR1, &observed_action, NULL) != 0) _exit(44);
        memset(&observed_action, 0, sizeof(observed_action));
        if (sigaction(SIGUSR1, NULL, &observed_action) != 0) _exit(45);
        if (observed_action.sa_handler != SIG_IGN) _exit(46);
        if (sigemptyset(&observed_mask) != 0) _exit(47);
        if (sigprocmask(SIG_SETMASK, &observed_mask, NULL) != 0) _exit(48);
        if (sigprocmask(SIG_SETMASK, NULL, &observed_mask) != 0) _exit(49);
        if (sigismember(&observed_mask, SIGUSR1) != 0) _exit(50);
        MARKER("CHILD_MUTATED_PRIVATE_POSIX_STATE\n");
        MARKER("CHILD_CONFIRMED_PRIVATE_POSIX_MUTATIONS\n");
        _exit(0);
    }

    MARKER("PARENT_AFTER_STATE_CHILD\n");
    if (getpid() != parent_pid || getppid() != parent_ppid) return 40;
    if (getuid() != 0 || geteuid() != 0) return 41;
    if (getgid() != 0 || getegid() != 0) return 42;
    if (getpgrp() != parent_pgrp || getsid(0) != parent_sid) return 43;
    if (getpgid(pid) != pid || getsid(pid) != parent_sid) return 44;
    if (getcwd(cwd, sizeof(cwd)) == NULL) return 45;
    if (strcmp(cwd, "/tmp/vfork-parent") != 0) return 46;
    if (fcntl(fd, F_GETFD) != 0) return 47;
    if (read(fd, &byte, 1) != 1 || byte != 'c') return 48;
    if (sigaction(SIGUSR1, NULL, &observed_action) != 0) return 49;
    if (observed_action.sa_handler != parent_signal_handler) return 50;
    if (sigprocmask(SIG_SETMASK, NULL, &observed_mask) != 0) return 51;
    if (sigismember(&observed_mask, SIGUSR1) != 1) return 52;
    MARKER("PARENT_POSIX_STATE_UNCHANGED\n");

    if (waitpid(pid, &status, 0) != pid) return 53;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 54;
    errno = 0;
    if (waitpid(pid, &status, WNOHANG) != -1 || errno != ECHILD) return 55;
    if (close(fd) != 0) return 56;
    if (sigprocmask(SIG_SETMASK, &original_mask, NULL) != 0) return 57;

    MARKER("PARENT_REAPED_STATE_CHILD\n");
    MARKER("PARENT_CONFIRMED_EXACT_REAP\n");
    MARKER("PASS: VFORK_POSIX_STATE\n");
    return 0;
}
