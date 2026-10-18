#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <pty.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

enum { API_COUNT = 5, ROUNDS = 16, REPAINT_BYTES = 16385 };
static unsigned char frame[REPAINT_BYTES];

static void require(int ok, const char *what) {
    if (!ok) { perror(what); exit(1); }
}

static double now_ms(void) {
    struct timespec ts;
    require(clock_gettime(CLOCK_MONOTONIC, &ts) == 0, "clock_gettime");
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1000000.0;
}

static void ready(int fd, int api) {
    if (api == 0) {
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        require(poll(&pfd, 1, 5000) == 1, "poll");
        require(pfd.revents & POLLIN, "poll readable");
    } else if (api == 1) {
        fd_set fds;
        FD_ZERO(&fds); FD_SET(fd, &fds);
        struct timeval timeout = { .tv_sec = 5 };
        require(select(fd + 1, &fds, NULL, NULL, &timeout) == 1, "select");
        require(FD_ISSET(fd, &fds), "select readable");
    } else if (api == 2) {
        fd_set fds;
        FD_ZERO(&fds); FD_SET(fd, &fds);
        struct timespec timeout = { .tv_sec = 5 };
        require(pselect(fd + 1, &fds, NULL, NULL, &timeout, NULL) == 1, "pselect");
        require(FD_ISSET(fd, &fds), "pselect readable");
    } else if (api == 3) {
        int epfd = epoll_create1(0);
        require(epfd >= 0, "epoll_create1");
        struct epoll_event event = { .events = EPOLLIN, .data.fd = fd };
        require(epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &event) == 0, "epoll_ctl");
        require(epoll_wait(epfd, &event, 1, 5000) == 1, "epoll_wait");
        require(event.events & EPOLLIN, "epoll readable");
        require(close(epfd) == 0, "close epoll");
    }
    // api 4 uses the blocking read itself, without a preceding readiness wait.
}

static void write_all(int fd, const unsigned char *bytes, size_t length) {
    while (length) {
        ssize_t n = write(fd, bytes, length);
        require(n > 0, "write");
        bytes += n; length -= (size_t)n;
    }
}

int main(void) {
    int master, slave;
    require(openpty(&master, &slave, NULL, NULL, NULL) == 0, "openpty");
    struct termios attrs;
    require(tcgetattr(slave, &attrs) == 0, "tcgetattr");
    cfmakeraw(&attrs);
    require(tcsetattr(slave, TCSANOW, &attrs) == 0, "tcsetattr");
    for (size_t i = 0; i < sizeof frame; i++) frame[i] = 'a' + i % 26;

    pid_t child = fork();
    require(child >= 0, "fork");
    if (!child) {
        require(close(master) == 0, "child close master");
        for (int api = 0; api < API_COUNT; api++) {
            for (int n = 0; n < ROUNDS; n++) {
                ready(slave, api);
                unsigned char key;
                require(read(slave, &key, 1) == 1 && key == 'k', "child key");
                write_all(slave, frame, sizeof frame);
            }
        }
        require(close(slave) == 0, "child close slave");
        _exit(0);
    }
    require(close(slave) == 0, "parent close slave");
    for (int api = 0; api < API_COUNT; api++) {
        double elapsed = 0;
        for (int n = 0; n < ROUNDS; n++) {
            // Allow the editor-side wait to park before the next key arrives.
            struct timespec pause = { .tv_nsec = 2000000 };
            require(nanosleep(&pause, NULL) == 0, "nanosleep");
            double start = now_ms();
            write_all(master, (const unsigned char *)"k", 1);
            size_t offset = 0;
            while (offset < sizeof frame) {
                ready(master, api);
                unsigned char bytes[1024];
                ssize_t count = read(master, bytes, sizeof bytes);
                require(count > 0 && (size_t)count <= sizeof frame - offset, "master read");
                require(memcmp(bytes, frame + offset, count) == 0, "repaint bytes");
                offset += count;
            }
            elapsed += now_ms() - start;
        }
        printf("PTY_ROUNDTRIP api=%d mean_ms=%.3f rounds=%d\n", api, elapsed / ROUNDS, ROUNDS);
    }
    struct pollfd hungup = { .fd = master, .events = POLLIN };
    require(poll(&hungup, 1, 5000) == 1 && (hungup.revents & POLLHUP), "slave hangup");
    require(close(master) == 0, "parent close master");
    int status;
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0, "waitpid");
    puts("PTY_READINESS_PASS");
    return 0;
}
