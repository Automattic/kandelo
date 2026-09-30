#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t sigchld_count;
static int handled_pipe_write = -1;

static void on_sigchld(int signum)
{
    (void)signum;
    int saved_errno = errno;
    sigchld_count++;
    /*
     * WHY: tell the connector the handler has run, so the connection can
     * never reach the listener before the signal meant to interrupt accept().
     * write() is async-signal-safe; the pipe cannot fill in this test.
     */
    if (handled_pipe_write >= 0) {
        char byte = 1;
        (void)write(handled_pipe_write, &byte, 1);
    }
    errno = saved_errno;
}

static void sleep_ms(long milliseconds)
{
    struct timespec delay = {
        .tv_sec = milliseconds / 1000,
        .tv_nsec = (milliseconds % 1000) * 1000000,
    };
    while (nanosleep(&delay, &delay) != 0 && errno == EINTR)
        ;
}

/*
 * Connect only after the parent's SIGCHLD handler has run. A fixed delay here
 * raced the exiting child: a Wasm child can start hundreds of milliseconds
 * late under load, and when the connection won, accept() correctly returned
 * it instead of EINTR.
 */
static int connect_after_handler(uint16_t port, int handled_pipe_read)
{
    char byte;
    ssize_t n;
    while ((n = read(handled_pipe_read, &byte, 1)) < 0 && errno == EINTR)
        ;
    if (n != 1)
        return 22;

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0)
        return 20;
    struct sockaddr_in address = {
        .sin_family = AF_INET,
        .sin_port = htons(port),
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
    };
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0)
        return 21;

    /*
     * WHY: stay alive until the parent closes the accepted connection, which
     * it does only after inspecting the handler count. Otherwise the
     * connector's own SIGCHLD could hide a lost signal from the child that
     * was meant to interrupt accept().
     */
    while ((n = read(fd, &byte, 1)) > 0 || (n < 0 && errno == EINTR))
        ;
    close(fd);
    return 0;
}

static int run_case(uint16_t port, int restart)
{
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_sigchld;
    action.sa_flags = restart ? SA_RESTART : 0;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL) != 0)
        return 2;
    sigchld_count = 0;

    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0)
        return 3;
    int reuse = 1;
    if (setsockopt(
            listener,
            SOL_SOCKET,
            SO_REUSEADDR,
            &reuse,
            sizeof(reuse)
        ) != 0)
        return 4;
    struct sockaddr_in address = {
        .sin_family = AF_INET,
        .sin_port = htons(port),
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
    };
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0)
        return 5;
    if (listen(listener, 4) != 0)
        return 6;

    int handled[2];
    if (pipe(handled) != 0)
        return 14;
    handled_pipe_write = handled[1];

    pid_t exiting_child = fork();
    if (exiting_child < 0)
        return 7;
    if (exiting_child == 0) {
        close(listener);
        close(handled[0]);
        close(handled[1]);
        sleep_ms(100);
        _exit(0);
    }

    pid_t connector = fork();
    if (connector < 0)
        return 8;
    if (connector == 0) {
        close(listener);
        close(handled[1]);
        _exit(connect_after_handler(port, handled[0]));
    }
    close(handled[0]);

    errno = 0;
    int accepted = accept(listener, NULL, NULL);
    int accept_errno = errno;
    if (!restart) {
        if (accepted >= 0 || accept_errno != EINTR) {
            fprintf(
                stderr,
                "accept without SA_RESTART returned %d, errno=%d\n",
                accepted,
                accept_errno
            );
            return 9;
        }
        accepted = accept(listener, NULL, NULL);
        accept_errno = errno;
    }

    if (accepted < 0) {
        fprintf(
            stderr,
            "accept with restart=%d returned errno=%d\n",
            restart,
            accept_errno
        );
        return 10;
    }
    if (sigchld_count != 1) {
        fprintf(
            stderr,
            "accept with restart=%d observed %d handlers, expected 1\n",
            restart,
            (int)sigchld_count
        );
        return 11;
    }

    close(accepted);
    close(listener);
    handled_pipe_write = -1;
    close(handled[1]);

    int status;
    if (waitpid(exiting_child, &status, 0) != exiting_child ||
        !WIFEXITED(status) || WEXITSTATUS(status) != 0)
        return 12;
    if (waitpid(connector, &status, 0) != connector ||
        !WIFEXITED(status) || WEXITSTATUS(status) != 0)
        return 13;
    return 0;
}

int main(void)
{
    int result = run_case(25254, 0);
    if (result != 0)
        return result;
    result = run_case(25255, 1);
    if (result != 0)
        return result;

    puts("PASS accept signal interruption and SA_RESTART");
    return 0;
}
