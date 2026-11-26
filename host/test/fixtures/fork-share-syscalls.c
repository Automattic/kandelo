#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static struct {
    char path[64];
    struct pollfd fds[1];
    fd_set set;
    struct timespec nano;
    struct timeval micro;
    sigset_t mask;
    struct epoll_event event;
    struct epoll_event ready[2];
    pid_t spawned;
    char text[32];
} s;

static int reap(pid_t pid) {
    int status = -1;
    if (pid <= 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return -1;
    return WEXITSTATUS(status);
}

static int checks(const char *name, int fd) {
    int failed = 0;
    int ends[2];
    if (pipe(ends) != 0 || dup2(ends[0], fd) != fd || write(ends[1], "x", 1) != 1) return 1 << 30;

    snprintf(s.path, sizeof s.path, "/tmp/sys-%s", name);
    int file = open(s.path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
    struct stat info;
    if (file < 0 || write(file, name, strlen(name)) < 0 || close(file) != 0 || stat(s.path, &info) != 0
        || info.st_size != (off_t)strlen(name)) failed |= 1;

    s.fds[0] = (struct pollfd){ .fd = fd, .events = POLLIN };
    if (poll(s.fds, 1, 0) != 1 || s.fds[0].revents != POLLIN) failed |= 2;

    s.fds[0] = (struct pollfd){ .fd = fd, .events = POLLIN };
    s.nano = (struct timespec){ 0, 1000 };
    sigemptyset(&s.mask);
    if (ppoll(s.fds, 1, &s.nano, &s.mask) != 1 || s.fds[0].revents != POLLIN) failed |= 4;

    FD_ZERO(&s.set);
    FD_SET(fd, &s.set);
    s.micro = (struct timeval){ 0, 1000 };
    if (select(fd + 1, &s.set, NULL, NULL, &s.micro) != 1 || !FD_ISSET(fd, &s.set)) failed |= 8;

    FD_ZERO(&s.set);
    FD_SET(fd, &s.set);
    s.nano = (struct timespec){ 0, 1000 };
    if (pselect(fd + 1, &s.set, NULL, NULL, &s.nano, &s.mask) != 1 || !FD_ISSET(fd, &s.set)) failed |= 16;

    int poller = epoll_create1(0);
    s.event = (struct epoll_event){ .events = EPOLLIN, .data.u32 = (unsigned)fd * 1000 };
    memset(s.ready, 0, sizeof s.ready);
    int added = poller < 0 ? -9 : epoll_ctl(poller, EPOLL_CTL_ADD, fd, &s.event);
    int count = epoll_pwait(poller, s.ready, 2, 0, &s.mask);
    if (added != 0 || count != 1
        || s.ready[0].events != EPOLLIN || s.ready[0].data.u32 != (unsigned)fd * 1000) {
        failed |= 32;
        fprintf(stderr, "%s epoll added=%d count=%d events=%x data=%u errno=%d\n", name, added, count, s.ready[0].events, s.ready[0].data.u32, errno);
    }

    s.spawned = -1;
    snprintf(s.text, sizeof s.text, "exit %d", fd);
    char *argv[] = { "sh", "-c", s.text, NULL };
    int spawn = posix_spawn(&s.spawned, "/bin/sh", NULL, NULL, argv, environ);
    int status = reap(s.spawned);
    if (spawn != 0 || status != fd) {
        failed |= 64;
        fprintf(stderr, "%s spawn=%d pid=%d status=%d\n", name, spawn, s.spawned, status);
    }

    return failed;
}

int main(void) {
    memset(&s, 0x55, sizeof s);
    pid_t child = fork();
    if (child == 0) {
        memset(&s, 0x11, sizeof s);
        int failed = checks("child", 20);
        printf("child failed=%d\n", failed);
        fflush(stdout);
        _exit(failed ? 2 : 42);
    }
    memset(&s, 0x22, sizeof s);
    int code = reap(child);
    int failed = checks("parent", 30);
    printf("parent forked=%d child=%d failed=%d\n", child > 0, code, failed);
    return failed || code != 42;
}
