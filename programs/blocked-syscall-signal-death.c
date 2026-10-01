/*
 * A signal that ends a blocked syscall must affect only its own process.
 *
 * Each case runs in a forked child that parks in a blocking syscall. The
 * parent then does what ends the wait: it closes the pipe's read end or the
 * socket's peer, or it sends a signal. The parent reaps the child and checks
 * how it ended: killed by the expected signal, or exited with the status the
 * child derived from its syscall result.
 *
 * `grep big | head` used to take down the whole kernel here: the writer's
 * retried write raised SIGPIPE, the kernel terminated the writer, and the
 * host then asked the kernel to deliver a signal to the dead task.
 *
 * The final case forks once more after all the others to prove the kernel
 * is still alive. Prints PASS, or FAIL lines.
 */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/resource.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#define BIG (256 * 1024)
static char big[BIG];

/* Child exit statuses that encode a syscall outcome. */
#define ST_EPIPE 10
#define ST_EPIPE_AFTER_HANDLER 11
#define ST_EINTR_AFTER_HANDLER 12
#define ST_UNEXPECTED 20

static volatile sig_atomic_t handled;
static void on_signal(int signo) { handled = signo; }

static void set_action(int signo, void (*handler)(int)) {
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = handler;
    sigemptyset(&sa.sa_mask);
    sigaction(signo, &sa, NULL);
}

/* Fill fd until the next write would block, then make it blocking again. */
static void fill(int fd) {
    int flags = fcntl(fd, F_GETFL);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    while (write(fd, big, 4096) > 0) {
    }
    fcntl(fd, F_SETFL, flags);
}

static int write_outcome(ssize_t r) {
    if (r == -1 && errno == EPIPE)
        return handled == SIGPIPE ? ST_EPIPE_AFTER_HANDLER : ST_EPIPE;
    return ST_UNEXPECTED;
}

enum writer { W_WRITE, W_LARGE_WRITE, W_WRITEV, W_SENDMSG };

/* Block in one write-family call on a full fd. */
static ssize_t blocked_write(int fd, enum writer how) {
    struct iovec iov[2] = {{big, 100}, {big, 100}};
    struct msghdr msg;
    switch (how) {
    case W_WRITE:
        return write(fd, big, 100);
    case W_LARGE_WRITE:
        return write(fd, big, BIG);
    case W_WRITEV:
        return writev(fd, iov, 2);
    case W_SENDMSG:
        memset(&msg, 0, sizeof msg);
        msg.msg_iov = iov;
        msg.msg_iovlen = 2;
        return sendmsg(fd, &msg, 0);
    }
    return -1;
}

static int failures;

static void expect(const char *name, pid_t pid, int want_signal, int want_status) {
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) {
        printf("FAIL %s: waitpid errno=%d\n", name, errno);
        failures++;
        return;
    }
    if (want_signal != 0) {
        if (!WIFSIGNALED(status) || WTERMSIG(status) != want_signal) {
            printf("FAIL %s: want signal %d, got status=0x%x\n", name, want_signal, status);
            failures++;
        }
        return;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != want_status) {
        printf("FAIL %s: want exit %d, got status=0x%x\n", name, want_status, status);
        failures++;
    }
}

/*
 * A writer blocks on a full pipe (or socketpair) and the reader closes.
 * disposition: 0 = default, 1 = ignore, 2 = handler.
 */
static void writer_case(const char *name, enum writer how, int use_socket,
                        int disposition, int want_signal, int want_status) {
    int fds[2];
    int rc = use_socket ? socketpair(AF_UNIX, SOCK_STREAM, 0, fds) : pipe(fds);
    if (rc != 0) {
        printf("FAIL %s: setup errno=%d\n", name, errno);
        failures++;
        return;
    }
    int rd = fds[0], wr = fds[1];
    pid_t pid = fork();
    if (pid == 0) {
        close(rd);
        if (disposition == 1)
            set_action(SIGPIPE, SIG_IGN);
        else if (disposition == 2)
            set_action(SIGPIPE, on_signal);
        fill(wr);
        _exit(write_outcome(blocked_write(wr, how)));
    }
    close(wr);
    /* Let the child fill the buffer and park in the blocked write. */
    usleep(300000);
    close(rd);
    expect(name, pid, want_signal, want_status);
}

/* A reader blocks on an empty pipe and another process signals it. */
static void reader_case(const char *name, int signo, int caught,
                        int want_signal, int want_status) {
    int fds[2];
    if (pipe(fds) != 0) {
        printf("FAIL %s: setup errno=%d\n", name, errno);
        failures++;
        return;
    }
    pid_t pid = fork();
    if (pid == 0) {
        char c;
        close(fds[1]);
        if (caught)
            set_action(signo, on_signal);
        ssize_t r = read(fds[0], &c, 1);
        _exit(r == -1 && errno == EINTR && handled == signo ? ST_EINTR_AFTER_HANDLER
                                                            : ST_UNEXPECTED);
    }
    usleep(300000);
    kill(pid, signo);
    expect(name, pid, want_signal, want_status);
    close(fds[0]);
    close(fds[1]);
}

/*
 * A blocked default-fatal signal is pending when a wait starts whose mask
 * unblocks it. The kernel terminates the process inside the wait.
 */
static void unmasking_wait_case(const char *name, int use_epoll) {
    pid_t pid = fork();
    if (pid == 0) {
        sigset_t term, open_mask;
        sigemptyset(&term);
        sigaddset(&term, SIGTERM);
        sigprocmask(SIG_BLOCK, &term, &open_mask);
        kill(getpid(), SIGTERM);
        /* Wait on a real, never-ready fd so the wait reaches the kernel. */
        int fds[2];
        pipe(fds);
        if (use_epoll) {
            int ep = epoll_create1(0);
            struct epoll_event ev = {.events = EPOLLIN, .data.fd = fds[0]};
            struct epoll_event out;
            epoll_ctl(ep, EPOLL_CTL_ADD, fds[0], &ev);
            epoll_pwait(ep, &out, 1, 5000, &open_mask);
        } else {
            fd_set readable;
            FD_ZERO(&readable);
            FD_SET(fds[0], &readable);
            struct timespec ts = {5, 0};
            pselect(fds[0] + 1, &readable, NULL, NULL, &ts, &open_mask);
        }
        _exit(ST_UNEXPECTED);
    }
    expect(name, pid, SIGTERM, 0);
}

/*
 * A vectored write past RLIMIT_FSIZE raises SIGXFSZ inside the same
 * transfer path, with no pipe involved.
 */
static void fsize_case(const char *name) {
    pid_t pid = fork();
    if (pid == 0) {
        struct rlimit limit = {16, 16};
        struct iovec iov[2] = {{big, 8}, {big, 8}};
        int fd = open("/tmp/blocked-syscall-signal-death.fsize",
                      O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (fd < 0 || setrlimit(RLIMIT_FSIZE, &limit) != 0)
            _exit(ST_UNEXPECTED);
        if (writev(fd, iov, 2) != 16)
            _exit(ST_UNEXPECTED);
        writev(fd, iov, 2);
        _exit(ST_UNEXPECTED);
    }
    expect(name, pid, SIGXFSZ, 0);
    unlink("/tmp/blocked-syscall-signal-death.fsize");
}

int main(void) {
    memset(big, 'x', sizeof big);

    writer_case("pipe write, default SIGPIPE", W_WRITE, 0, 0, SIGPIPE, 0);
    writer_case("pipe large write, default SIGPIPE", W_LARGE_WRITE, 0, 0, SIGPIPE, 0);
    writer_case("pipe writev, default SIGPIPE", W_WRITEV, 0, 0, SIGPIPE, 0);
    writer_case("pipe write, SIGPIPE ignored", W_WRITE, 0, 1, 0, ST_EPIPE);
    writer_case("pipe writev, SIGPIPE ignored", W_WRITEV, 0, 1, 0, ST_EPIPE);
    writer_case("pipe large write, SIGPIPE ignored", W_LARGE_WRITE, 0, 1, 0, ST_EPIPE);
    writer_case("pipe writev, SIGPIPE caught", W_WRITEV, 0, 2, 0, ST_EPIPE_AFTER_HANDLER);
    writer_case("socket sendmsg, default SIGPIPE", W_SENDMSG, 1, 0, SIGPIPE, 0);
    writer_case("socket write, default SIGPIPE", W_WRITE, 1, 0, SIGPIPE, 0);
    writer_case("socket sendmsg, SIGPIPE ignored", W_SENDMSG, 1, 1, 0, ST_EPIPE);

    reader_case("pipe read, SIGTERM from another process", SIGTERM, 0, SIGTERM, 0);
    reader_case("pipe read, caught SIGUSR1 from another process", SIGUSR1, 1, 0,
                ST_EINTR_AFTER_HANDLER);

    fsize_case("file writev past RLIMIT_FSIZE, default SIGXFSZ");

    unmasking_wait_case("pselect unmasks pending SIGTERM", 0);
    unmasking_wait_case("epoll_pwait unmasks pending SIGTERM", 1);

    /* The kernel survived every death above: it can still run a process. */
    pid_t pid = fork();
    if (pid == 0)
        _exit(0);
    expect("kernel still spawns after signal deaths", pid, 0, 0);

    if (failures == 0)
        printf("PASS\n");
    fflush(stdout);
    return failures == 0 ? 0 : 1;
}
