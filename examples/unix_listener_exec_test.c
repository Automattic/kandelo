#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *const program_path = "/bin/unix-listener-exec";
static const char *const socket_path = "/tmp/unix-listener-exec.sock";

static int parse_fd(const char *arg, const char *name)
{
    char *end = NULL;
    errno = 0;
    long parsed = strtol(arg, &end, 10);
    if (errno != 0 || end == arg || *end != '\0' || parsed < 0 ||
        parsed > 1024) {
        fprintf(stderr, "invalid %s fd: %s\n", name, arg);
        return -1;
    }
    return (int)parsed;
}

static int write_exact(int fd, const char *buf, size_t len)
{
    size_t offset = 0;
    while (offset < len) {
        ssize_t written = write(fd, buf + offset, len - offset);
        if (written <= 0)
            return -1;
        offset += (size_t)written;
    }
    return 0;
}

static int read_exact(int fd, char *buf, size_t len)
{
    size_t offset = 0;
    while (offset < len) {
        ssize_t received = read(fd, buf + offset, len - offset);
        if (received <= 0)
            return -1;
        offset += (size_t)received;
    }
    return 0;
}

static int worker_main(const char *listener_arg, const char *cloexec_arg,
    const char *ready_arg)
{
    int listener = parse_fd(listener_arg, "inherited listener");
    int cloexec_listener = parse_fd(cloexec_arg, "CLOEXEC listener");
    int ready = parse_fd(ready_arg, "ready pipe");
    if (listener < 0 || cloexec_listener < 0 || ready < 0)
        return 20;

    errno = 0;
    if (fcntl(cloexec_listener, F_GETFD) != -1 || errno != EBADF) {
        fprintf(stderr, "CLOEXEC listener survived exec\n");
        return 21;
    }

    int accepting = 0;
    socklen_t accepting_len = sizeof(accepting);
    if (getsockopt(listener, SOL_SOCKET, SO_ACCEPTCONN, &accepting,
            &accepting_len) != 0 || accepting != 1) {
        perror("post-exec getsockopt(SO_ACCEPTCONN)");
        return 22;
    }

    if (write_exact(ready, "R", 1) != 0) {
        perror("post-exec ready write");
        return 23;
    }
    close(ready);

    static const char *const requests[] = { "PRE1", "POST" };
    static const char *const responses[] = { "ACK1", "ACK2" };
    for (size_t i = 0; i < 2; ++i) {
        int peer = accept(listener, NULL, NULL);
        if (peer < 0) {
            perror("post-exec accept");
            return 24;
        }

        char request[4];
        if (read_exact(peer, request, sizeof(request)) != 0 ||
            memcmp(request, requests[i], sizeof(request)) != 0) {
            fprintf(stderr,
                "post-exec accept %zu received the wrong request\n", i);
            return 25;
        }
        if (write_exact(peer, responses[i], 4) != 0) {
            perror("post-exec accepted socket write");
            return 26;
        }
        close(peer);
    }

    int flags = fcntl(listener, F_GETFL);
    if (flags < 0 || fcntl(listener, F_SETFL, flags | O_NONBLOCK) != 0) {
        perror("post-exec listener nonblock");
        return 27;
    }
    errno = 0;
    int extra = accept(listener, NULL, NULL);
    if (extra != -1 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
        fprintf(stderr, "listener queue was not consumed exactly once\n");
        return 28;
    }

    close(listener);
    return 0;
}

static int make_listener(void)
{
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        perror("socket listener");
        return -1;
    }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(socket_path) >= sizeof(addr.sun_path)) {
        fprintf(stderr, "socket path is too long\n");
        close(fd);
        return -1;
    }
    strcpy(addr.sun_path, socket_path);

    unlink(socket_path);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        perror("bind listener");
        close(fd);
        return -1;
    }
    if (listen(fd, 4) != 0) {
        perror("listen");
        close(fd);
        return -1;
    }
    return fd;
}

static int connect_client(void)
{
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket client");
        return -1;
    }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strcpy(addr.sun_path, socket_path);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        perror("connect");
        close(fd);
        return -1;
    }
    return fd;
}

int main(int argc, char **argv)
{
    alarm(20);
    if (argc == 5 && strcmp(argv[1], "worker") == 0)
        return worker_main(argv[2], argv[3], argv[4]);

    int cloexec_listener = make_listener();
    if (cloexec_listener < 0)
        return 1;
    int listener = dup(cloexec_listener);
    if (listener < 0) {
        perror("dup listener");
        return 2;
    }
    int cloexec_flags = fcntl(cloexec_listener, F_GETFD);
    int listener_flags = fcntl(listener, F_GETFD);
    if (cloexec_flags < 0 || listener_flags < 0) {
        perror("listener F_GETFD");
        return 2;
    }
    if ((cloexec_flags & FD_CLOEXEC) == 0 ||
        (listener_flags & FD_CLOEXEC) != 0) {
        fprintf(stderr, "dup did not preserve the expected CLOEXEC split\n");
        return 2;
    }

    int exec_gate[2];
    int ready[2];
    if (pipe(exec_gate) != 0 || pipe(ready) != 0) {
        perror("coordination pipe");
        return 3;
    }

    pid_t child = fork();
    if (child < 0) {
        perror("fork");
        return 4;
    }
    if (child == 0) {
        close(exec_gate[1]);
        close(ready[0]);
        char byte;
        if (read_exact(exec_gate[0], &byte, 1) != 0) {
            perror("child exec gate read");
            _exit(10);
        }
        close(exec_gate[0]);

        char listener_arg[16];
        char cloexec_arg[16];
        char ready_arg[16];
        snprintf(listener_arg, sizeof(listener_arg), "%d", listener);
        snprintf(cloexec_arg, sizeof(cloexec_arg), "%d", cloexec_listener);
        snprintf(ready_arg, sizeof(ready_arg), "%d", ready[1]);
        char *exec_argv[] = {
            (char *)program_path,
            "worker",
            listener_arg,
            cloexec_arg,
            ready_arg,
            NULL,
        };
        char *exec_envp[] = { NULL };
        execve(program_path, exec_argv, exec_envp);
        perror("execve worker");
        _exit(11);
    }

    close(exec_gate[0]);
    close(ready[1]);
    int pre_exec_client = connect_client();
    if (pre_exec_client < 0)
        return 5;

    // Drop every listener alias in the parent. The child is now the only
    // process that can keep the pathname registration and shared queue alive.
    close(cloexec_listener);
    close(listener);

    // The connection is queued while the child still runs the pre-exec
    // image. Releasing the gate makes the child replace that image and prove
    // that its inherited listener still owns this exact pending connection.
    if (write_exact(exec_gate[1], "x", 1) != 0) {
        perror("parent gate write");
        return 6;
    }
    close(exec_gate[1]);

    char byte;
    if (read_exact(ready[0], &byte, 1) != 0) {
        perror("parent ready read");
        return 7;
    }
    close(ready[0]);

    int post_exec_client = connect_client();
    if (post_exec_client < 0)
        return 8;

    if (write_exact(pre_exec_client, "PRE1", 4) != 0 ||
        write_exact(post_exec_client, "POST", 4) != 0) {
        perror("client write");
        return 9;
    }
    char first_response[4];
    char second_response[4];
    if (read_exact(pre_exec_client, first_response, sizeof(first_response)) != 0 ||
        memcmp(first_response, "ACK1", sizeof(first_response)) != 0 ||
        read_exact(post_exec_client, second_response, sizeof(second_response)) != 0 ||
        memcmp(second_response, "ACK2", sizeof(second_response)) != 0) {
        fprintf(stderr, "clients received the wrong responses\n");
        return 10;
    }
    close(pre_exec_client);
    close(post_exec_client);

    int status = 0;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) ||
        WEXITSTATUS(status) != 0) {
        fprintf(stderr, "exec worker failed: status=%d\n", status);
        return 11;
    }

    unlink(socket_path);
    alarm(0);
    puts("UNIX_LISTENER_EXEC_PASS");
    return 0;
}
