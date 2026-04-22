/* Diagnostic program for investigating Linux-CI sortix PTY failures.
 *
 * The sortix termios tests consistently fail on Linux CI with
 * "/dev/pts/1: ENOENT" — meaning the first PTY their posix_openpt()
 * returns is index 1 (not 0), and opening /dev/pts/1 then fails.
 *
 * This program prints the PTY indices seen for the first two allocations
 * plus the fork-child's view, so we can compare Mac vs Linux output.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>

extern int posix_openpt(int flags);
extern char *ptsname(int fd);

int main(void) {
    fprintf(stderr, "=== PTY diagnostic ===\n");
    fprintf(stderr, "pid=%d ppid=%d\n", getpid(), getppid());

    int m1 = posix_openpt(O_RDWR | O_NOCTTY);
    fprintf(stderr, "first posix_openpt: fd=%d errno=%d(%s)\n",
            m1, errno, strerror(errno));

    if (m1 >= 0) {
        int u = 0;
        if (ioctl(m1, 0x40045431 /* TIOCSPTLCK */, &u) < 0) {
            fprintf(stderr, "  unlockpt ioctl failed: %d(%s)\n", errno, strerror(errno));
        }
        char *name = ptsname(m1);
        fprintf(stderr, "  ptsname='%s'\n", name ? name : "NULL");

        pid_t pid = fork();
        if (pid == 0) {
            fprintf(stderr, "[child] pid=%d ppid=%d\n", getpid(), getppid());
            if (close(m1) < 0) {
                fprintf(stderr, "[child] close(controller) failed: %d(%s)\n",
                        errno, strerror(errno));
            }
            int slave = open(name, O_RDWR);
            fprintf(stderr, "[child] open('%s') = %d errno=%d(%s)\n",
                    name, slave, errno, strerror(errno));
            _exit(0);
        }
        int status;
        waitpid(pid, &status, 0);
        fprintf(stderr, "child status=0x%x\n", status);
    }

    int m2 = posix_openpt(O_RDWR | O_NOCTTY);
    fprintf(stderr, "second posix_openpt: fd=%d errno=%d\n", m2, errno);
    if (m2 >= 0) {
        char *name2 = ptsname(m2);
        fprintf(stderr, "  ptsname='%s'\n", name2 ? name2 : "NULL");
    }

    return 0;
}
