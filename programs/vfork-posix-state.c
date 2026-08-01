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

int main(void) {
    static const char contents[] = "abcdef";
    char cwd[64];
    char byte = '\0';
    int status = 0;

    if (getuid() != 0 || geteuid() != 0) return 1;
    if (getgid() != 0 || getegid() != 0) return 2;
    if (mkdir("/tmp/vfork-parent", 0755) != 0 && errno != EEXIST) return 3;
    if (chdir("/tmp/vfork-parent") != 0) return 4;

    int fd = open("ofd-state", O_CREAT | O_TRUNC | O_RDWR, 0644);
    if (fd < 0) return 5;
    if (write(fd, contents, sizeof(contents) - 1) != sizeof(contents) - 1) {
        return 6;
    }
    if (lseek(fd, 0, SEEK_SET) != 0) return 7;
    if (fcntl(fd, F_GETFD) != 0) return 8;

    pid_t parent_pgrp = getpgrp();
    if (parent_pgrp <= 0) return 9;

    pid_t pid = vfork();
    if (pid < 0) return 10;
    if (pid == 0) {
        if (getuid() != 0 || getgid() != 0) _exit(21);
        if (getpgrp() != parent_pgrp) _exit(22);
        if (lseek(fd, 2, SEEK_SET) != 2) _exit(23);
        if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0) _exit(24);
        if (close(fd) != 0) _exit(25);
        if (chdir("/") != 0) _exit(26);
        if (setpgid(0, 0) != 0) _exit(27);
        if (setgid(1234) != 0) _exit(28);
        if (setuid(1234) != 0) _exit(29);
        _exit(0);
    }

    MARKER("PARENT_AFTER_STATE_CHILD\n");
    if (getuid() != 0 || geteuid() != 0) return 11;
    if (getgid() != 0 || getegid() != 0) return 12;
    if (getpgrp() != parent_pgrp) return 13;
    if (getpgid(pid) != pid) return 14;
    if (getcwd(cwd, sizeof(cwd)) == NULL) return 15;
    if (strcmp(cwd, "/tmp/vfork-parent") != 0) return 16;
    if (fcntl(fd, F_GETFD) != 0) return 17;
    if (read(fd, &byte, 1) != 1 || byte != 'c') return 18;
    if (waitpid(pid, &status, 0) != pid) return 19;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 20;
    if (close(fd) != 0) return 30;

    MARKER("PARENT_REAPED_STATE_CHILD\n");
    MARKER("PASS: VFORK_POSIX_STATE\n");
    return 0;
}
