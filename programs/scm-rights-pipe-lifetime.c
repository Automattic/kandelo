#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static int reset_fifo(const char *path) {
    if (unlink(path) < 0 && errno != ENOENT)
        return -1;
    return mkfifo(path, 0600);
}

static int is_fifo_fd(int fd) {
    struct stat status;
    return fstat(fd, &status) == 0 && S_ISFIFO(status.st_mode);
}

static int has_hangup(int fd) {
    struct pollfd pfd = {
        .fd = fd,
        .events = POLLIN | POLLOUT,
    };
    return poll(&pfd, 1, 0) == 1 && (pfd.revents & POLLHUP) != 0;
}

static int discard_rights_message(int socket_fd) {
    char byte = 0;
    struct iovec iov = {
        .iov_base = &byte,
        .iov_len = sizeof(byte),
    };
    struct msghdr message = {
        .msg_iov = &iov,
        .msg_iovlen = 1,
    };
    if (recvmsg(socket_fd, &message, 0) != 1 ||
        (message.msg_flags & MSG_CTRUNC) == 0) {
        errno = EIO;
        return -1;
    }
    return 0;
}

static int send_fds(int socket_fd, const int *fds, size_t count) {
    if (count == 0 || count > 2) {
        errno = EINVAL;
        return -1;
    }
    char byte = 'R';
    struct iovec iov = {
        .iov_base = &byte,
        .iov_len = sizeof(byte),
    };
    char control[CMSG_SPACE(2 * sizeof(int))];
    memset(control, 0, sizeof(control));
    struct msghdr message = {
        .msg_iov = &iov,
        .msg_iovlen = 1,
        .msg_control = control,
        .msg_controllen = CMSG_SPACE(count * sizeof(int)),
    };
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&message);
    cmsg->cmsg_len = CMSG_LEN(count * sizeof(int));
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type = SCM_RIGHTS;
    memcpy(CMSG_DATA(cmsg), fds, count * sizeof(int));
    return sendmsg(socket_fd, &message, 0) == 1 ? 0 : -1;
}

static int send_fd(int socket_fd, int fd) {
    return send_fds(socket_fd, &fd, 1);
}

static int receive_fds_with_flags(int socket_fd, int *fds, size_t capacity,
                                  int *message_flags) {
    if (capacity == 0 || capacity > 2) {
        errno = EINVAL;
        return -1;
    }
    char byte = 0;
    struct iovec iov = {
        .iov_base = &byte,
        .iov_len = sizeof(byte),
    };
    char control[CMSG_SPACE(2 * sizeof(int))];
    memset(control, 0, sizeof(control));
    struct msghdr message = {
        .msg_iov = &iov,
        .msg_iovlen = 1,
        .msg_control = control,
        .msg_controllen = CMSG_SPACE(capacity * sizeof(int)),
    };
    if (recvmsg(socket_fd, &message, 0) != 1)
        return -1;
    if (message_flags)
        *message_flags = message.msg_flags;
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&message);
    if (!cmsg || cmsg->cmsg_level != SOL_SOCKET ||
        cmsg->cmsg_type != SCM_RIGHTS ||
        cmsg->cmsg_len < CMSG_LEN(sizeof(int))) {
        errno = EBADMSG;
        return -1;
    }
    size_t count = (cmsg->cmsg_len - CMSG_LEN(0)) / sizeof(int);
    if (count == 0 || count > capacity) {
        errno = EBADMSG;
        return -1;
    }
    memcpy(fds, CMSG_DATA(cmsg), count * sizeof(int));
    return (int)count;
}

static int receive_fds(int socket_fd, int *fds, size_t capacity) {
    return receive_fds_with_flags(socket_fd, fds, capacity, NULL);
}

static int receive_fd(int socket_fd) {
    int fd = -1;
    return receive_fds(socket_fd, &fd, 1) == 1 ? fd : -1;
}

static int transferred_endpoint_survives_sender_close(void) {
    int carrier[2];
    int data_pipe[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 || pipe(data_pipe) < 0)
        return -1;
    if (write(data_pipe[1], "before", 6) != 6 ||
        send_fd(carrier[0], data_pipe[0]) < 0 || close(data_pipe[0]) < 0 ||
        write(data_pipe[1], "after", 5) != 5) {
        return -1;
    }

    int received = receive_fd(carrier[1]);
    if (received < 0 || close(data_pipe[1]) < 0)
        return -1;

    char payload[11];
    ssize_t total = 0;
    while (total < (ssize_t)sizeof(payload)) {
        ssize_t count = read(received, payload + total, sizeof(payload) - total);
        if (count <= 0)
            return -1;
        total += count;
    }
    char extra;
    if (memcmp(payload, "beforeafter", sizeof(payload)) != 0 ||
        read(received, &extra, sizeof(extra)) != 0) {
        errno = EIO;
        return -1;
    }

    return close(received) | close(carrier[0]) | close(carrier[1]);
}

static int transferred_writer_survives_sender_close(void) {
    int carrier[2];
    int data_pipe[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 || pipe(data_pipe) < 0)
        return -1;
    if (send_fd(carrier[0], data_pipe[1]) < 0 || close(data_pipe[1]) < 0)
        return -1;

    int received = receive_fd(carrier[1]);
    if (received < 0 || write(received, "writer", 6) != 6 || close(received) < 0)
        return -1;

    char payload[6];
    ssize_t count = read(data_pipe[0], payload, sizeof(payload));
    char extra;
    if (count != (ssize_t)sizeof(payload) ||
        memcmp(payload, "writer", sizeof(payload)) != 0 ||
        read(data_pipe[0], &extra, sizeof(extra)) != 0) {
        errno = EIO;
        return -1;
    }

    return close(data_pipe[0]) | close(carrier[0]) | close(carrier[1]);
}

static int abandoned_endpoint_is_released(void) {
    int carrier[2];
    int data_pipe[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 || pipe(data_pipe) < 0)
        return -1;
    if (send_fd(carrier[0], data_pipe[0]) < 0 || close(data_pipe[0]) < 0 ||
        write(data_pipe[1], "held", 4) != 4 || close(carrier[0]) < 0 ||
        close(carrier[1]) < 0) {
        return -1;
    }

    errno = 0;
    if (write(data_pipe[1], "released", 8) != -1 || errno != EPIPE)
        return -1;
    return close(data_pipe[1]);
}

static int unreturnable_endpoint_is_released(void) {
    int carrier[2];
    int data_pipe[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 || pipe(data_pipe) < 0)
        return -1;
    if (send_fd(carrier[0], data_pipe[0]) < 0 || close(data_pipe[0]) < 0 ||
        write(data_pipe[1], "held", 4) != 4) {
        return -1;
    }

    char byte = 0;
    struct iovec iov = {
        .iov_base = &byte,
        .iov_len = sizeof(byte),
    };
    struct msghdr message = {
        .msg_iov = &iov,
        .msg_iovlen = 1,
    };
    if (recvmsg(carrier[1], &message, 0) != 1 ||
        (message.msg_flags & MSG_CTRUNC) == 0) {
        return -1;
    }

    errno = 0;
    if (write(data_pipe[1], "released", 8) != -1 || errno != EPIPE)
        return -1;
    return close(data_pipe[1]) | close(carrier[0]) | close(carrier[1]);
}

static int reachable_socket_right_cycles_deliver(void) {
    int self[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, self) < 0 ||
        send_fd(self[0], self[1]) < 0) {
        return -1;
    }
    int received_self = receive_fd(self[1]);
    char byte = 0;
    if (received_self < 0 || close(self[1]) < 0 ||
        write(self[0], "S", 1) != 1 || read(received_self, &byte, 1) != 1 ||
        byte != 'S' || write(received_self, "T", 1) != 1 ||
        read(self[0], &byte, 1) != 1 || byte != 'T' || close(self[0]) < 0 ||
        close(received_self) < 0) {
        return -1;
    }

    int a[2];
    int b[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, a) < 0 ||
        socketpair(AF_UNIX, SOCK_STREAM, 0, b) < 0 ||
        send_fd(a[0], b[1]) < 0 || send_fd(b[0], a[1]) < 0) {
        return -1;
    }
    int received_b = receive_fd(a[1]);
    int received_a = receive_fd(b[1]);
    if (received_a < 0 || received_b < 0 || close(a[1]) < 0 ||
        close(b[1]) < 0 || write(a[0], "A", 1) != 1 ||
        read(received_a, &byte, 1) != 1 || byte != 'A' ||
        write(b[0], "B", 1) != 1 || read(received_b, &byte, 1) != 1 ||
        byte != 'B' || close(a[0]) < 0 || close(b[0]) < 0 ||
        close(received_a) < 0 || close(received_b) < 0) {
        return -1;
    }
    return 0;
}

static int abandoned_socket_right_cycles_are_collected(void) {
    for (int i = 0; i < 64; ++i) {
        int self[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, self) < 0 ||
            send_fd(self[0], self[1]) < 0 || close(self[0]) < 0 ||
            close(self[1]) < 0) {
            return -1;
        }
    }

    int a[2];
    int b[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, a) < 0 ||
        socketpair(AF_UNIX, SOCK_STREAM, 0, b) < 0 ||
        send_fd(a[0], b[1]) < 0 || send_fd(b[0], a[1]) < 0 ||
        close(a[0]) < 0 || close(a[1]) < 0 || close(b[0]) < 0 ||
        close(b[1]) < 0) {
        return -1;
    }
    return 0;
}

static int receiver_control_truncation_installs_prefix_and_releases_excess(void) {
    int carrier[2];
    int first[2];
    int second[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 || pipe(first) < 0 ||
        pipe(second) < 0) {
        return -1;
    }

    int sent[2] = {first[0], second[0]};
    if (send_fds(carrier[0], sent, 2) < 0 || close(first[0]) < 0 ||
        close(second[0]) < 0) {
        return -1;
    }

    int received = -1;
    int message_flags = 0;
    int count = receive_fds_with_flags(carrier[1], &received, 1,
                                        &message_flags);
    if (count != 1 || (message_flags & MSG_CTRUNC) == 0 ||
        write(first[1], "kept", 4) != 4) {
        return -1;
    }

    char payload[4];
    if (read(received, payload, sizeof(payload)) != (ssize_t)sizeof(payload) ||
        memcmp(payload, "kept", sizeof(payload)) != 0) {
        errno = EIO;
        return -1;
    }

    errno = 0;
    if (write(second[1], "dropped", 7) != -1 || errno != EPIPE)
        return -1;
    return close(received) | close(first[1]) | close(second[1]) |
           close(carrier[0]) | close(carrier[1]);
}

static int receiver_emfile_partially_installs_and_releases(void) {
    int carrier[2];
    int first[2];
    int second[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 || pipe(first) < 0 ||
        pipe(second) < 0) {
        return -1;
    }

    int sent[2] = {first[0], second[0]};
    if (send_fds(carrier[0], sent, 2) < 0 || close(first[0]) < 0 ||
        close(second[0]) < 0) {
        return -1;
    }

    struct rlimit saved;
    if (getrlimit(RLIMIT_NOFILE, &saved) < 0)
        return -1;
    struct rlimit limited = saved;
    limited.rlim_cur = (rlim_t)sent[0] + 1;
    if (setrlimit(RLIMIT_NOFILE, &limited) < 0)
        return -1;

    int received[2] = {-1, -1};
    int message_flags = 0;
    int count = receive_fds_with_flags(carrier[1], received, 2,
                                        &message_flags);
    int receive_errno = errno;
    if (setrlimit(RLIMIT_NOFILE, &saved) < 0)
        return -1;
    if (count != 1 || (message_flags & MSG_CTRUNC) == 0) {
        errno = receive_errno ? receive_errno : EMFILE;
        return -1;
    }

    if (write(first[1], "kept", 4) != 4)
        return -1;
    char payload[4];
    if (read(received[0], payload, sizeof(payload)) != (ssize_t)sizeof(payload) ||
        memcmp(payload, "kept", sizeof(payload)) != 0) {
        errno = EIO;
        return -1;
    }

    errno = 0;
    if (write(second[1], "dropped", 7) != -1 || errno != EPIPE)
        return -1;
    return close(received[0]) | close(first[1]) | close(second[1]) |
           close(carrier[0]) | close(carrier[1]);
}

static int transferred_fifo_path_survives_sender_close_and_unlink(void) {
    const char *path = "/tmp/scm-rights-fifo-path";
    int carrier[2];
    if (reset_fifo(path) < 0 || socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0)
        return -1;

    int path_fd = open(path, O_PATH);
    if (path_fd < 0 || send_fd(carrier[0], path_fd) < 0 || close(path_fd) < 0 ||
        unlink(path) < 0) {
        return -1;
    }

    int received = receive_fd(carrier[1]);
    if (received < 0 || !is_fifo_fd(received)) {
        errno = EIO;
        return -1;
    }
    return close(received) | close(carrier[0]) | close(carrier[1]);
}

static int transferred_fifo_reader_preserves_hangup_cohort(void) {
    const char *path = "/tmp/scm-rights-fifo-reader";
    int carrier[2];
    if (reset_fifo(path) < 0 || socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0)
        return -1;

    int reader = open(path, O_RDONLY | O_NONBLOCK);
    int writer = open(path, O_WRONLY | O_NONBLOCK);
    if (reader < 0 || writer < 0 || send_fd(carrier[0], reader) < 0 ||
        close(reader) < 0) {
        return -1;
    }

    int received = receive_fd(carrier[1]);
    char byte = 0;
    if (received < 0 || close(writer) < 0 || !has_hangup(received) ||
        read(received, &byte, sizeof(byte)) != 0) {
        errno = EIO;
        return -1;
    }
    return close(received) | close(carrier[0]) | close(carrier[1]) |
           unlink(path);
}

static int transferred_fifo_writer_survives_sender_close(void) {
    const char *path = "/tmp/scm-rights-fifo-writer";
    int carrier[2];
    if (reset_fifo(path) < 0 || socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0)
        return -1;

    int reader = open(path, O_RDONLY | O_NONBLOCK);
    int writer = open(path, O_WRONLY | O_NONBLOCK);
    if (reader < 0 || writer < 0 || send_fd(carrier[0], writer) < 0 ||
        close(writer) < 0) {
        return -1;
    }

    int received = receive_fd(carrier[1]);
    char payload[6];
    char extra = 0;
    if (received < 0 || write(received, "writer", 6) != 6 ||
        read(reader, payload, sizeof(payload)) != (ssize_t)sizeof(payload) ||
        memcmp(payload, "writer", sizeof(payload)) != 0 || close(received) < 0 ||
        read(reader, &extra, sizeof(extra)) != 0) {
        errno = EIO;
        return -1;
    }
    return close(reader) | close(carrier[0]) | close(carrier[1]) | unlink(path);
}

static int transferred_fifo_read_write_survives_sender_close(void) {
    const char *path = "/tmp/scm-rights-fifo-rw";
    int carrier[2];
    if (reset_fifo(path) < 0 || socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0)
        return -1;

    int read_write = open(path, O_RDWR | O_NONBLOCK);
    if (read_write < 0 || send_fd(carrier[0], read_write) < 0 ||
        close(read_write) < 0) {
        return -1;
    }

    int received = receive_fd(carrier[1]);
    char payload[2];
    if (received < 0 || write(received, "rw", 2) != 2 ||
        read(received, payload, sizeof(payload)) != (ssize_t)sizeof(payload) ||
        memcmp(payload, "rw", sizeof(payload)) != 0) {
        errno = EIO;
        return -1;
    }
    return close(received) | close(carrier[0]) | close(carrier[1]) |
           unlink(path);
}

static int discarded_fifo_references_are_released(void) {
    const char *path = "/tmp/scm-rights-fifo-discard";

    // A discarded path-only right must not keep an unlinked FIFO alive.
    for (int i = 0; i < 32; ++i) {
        int carrier[2];
        if (reset_fifo(path) < 0 ||
            socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0) {
            return -1;
        }
        int path_fd = open(path, O_PATH);
        if (path_fd < 0 || send_fd(carrier[0], path_fd) < 0 ||
            close(path_fd) < 0 || unlink(path) < 0 ||
            discard_rights_message(carrier[1]) < 0 || close(carrier[0]) < 0 ||
            close(carrier[1]) < 0) {
            return -1;
        }
    }

    // A discarded read-only right releases both its endpoint and FIFO cohort.
    int carrier[2];
    if (reset_fifo(path) < 0 || socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0)
        return -1;
    int reader = open(path, O_RDONLY | O_NONBLOCK);
    int writer = open(path, O_WRONLY | O_NONBLOCK);
    if (reader < 0 || writer < 0 || send_fd(carrier[0], reader) < 0 ||
        close(reader) < 0 || discard_rights_message(carrier[1]) < 0) {
        return -1;
    }
    errno = 0;
    if (write(writer, "dropped", 7) != -1 || errno != EPIPE || close(writer) < 0 ||
        close(carrier[0]) < 0 || close(carrier[1]) < 0 || unlink(path) < 0) {
        return -1;
    }

    // A discarded write right exposes EOF and HUP to the remaining reader.
    if (reset_fifo(path) < 0 || socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0)
        return -1;
    reader = open(path, O_RDONLY | O_NONBLOCK);
    writer = open(path, O_WRONLY | O_NONBLOCK);
    char byte = 0;
    if (reader < 0 || writer < 0 || send_fd(carrier[0], writer) < 0 ||
        close(writer) < 0 || discard_rights_message(carrier[1]) < 0 ||
        !has_hangup(reader) || read(reader, &byte, sizeof(byte)) != 0 ||
        close(reader) < 0 || close(carrier[0]) < 0 || close(carrier[1]) < 0 ||
        unlink(path) < 0) {
        errno = EIO;
        return -1;
    }

    // O_RDWR owns both endpoints but is not a read-only cohort member.
    if (reset_fifo(path) < 0 || socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0)
        return -1;
    reader = open(path, O_RDONLY | O_NONBLOCK);
    int read_write = open(path, O_RDWR | O_NONBLOCK);
    if (reader < 0 || read_write < 0 || send_fd(carrier[0], read_write) < 0 ||
        close(read_write) < 0 || discard_rights_message(carrier[1]) < 0 ||
        !has_hangup(reader) || read(reader, &byte, sizeof(byte)) != 0 ||
        close(reader) < 0 || close(carrier[0]) < 0 || close(carrier[1]) < 0 ||
        unlink(path) < 0) {
        errno = EIO;
        return -1;
    }
    return 0;
}

static int fifo_emfile_installs_path_and_releases_reader(void) {
    const char *path = "/tmp/scm-rights-fifo-emfile";
    int carrier[2];
    if (reset_fifo(path) < 0 || socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0)
        return -1;

    // Open the path first so its recycled descriptor is the only slot below
    // the temporary RLIMIT_NOFILE ceiling.
    int path_fd = open(path, O_PATH);
    int reader = open(path, O_RDONLY | O_NONBLOCK);
    int writer = open(path, O_WRONLY | O_NONBLOCK);
    int sent[2] = {path_fd, reader};
    if (path_fd < 0 || reader < 0 || writer < 0 ||
        send_fds(carrier[0], sent, 2) < 0 || close(path_fd) < 0 ||
        close(reader) < 0) {
        return -1;
    }

    struct rlimit saved;
    if (getrlimit(RLIMIT_NOFILE, &saved) < 0)
        return -1;
    struct rlimit limited = saved;
    limited.rlim_cur = (rlim_t)path_fd + 1;
    if (setrlimit(RLIMIT_NOFILE, &limited) < 0)
        return -1;

    int received[2] = {-1, -1};
    int message_flags = 0;
    int count = receive_fds_with_flags(carrier[1], received, 2, &message_flags);
    int receive_errno = errno;
    if (setrlimit(RLIMIT_NOFILE, &saved) < 0)
        return -1;
    if (count != 1 || (message_flags & MSG_CTRUNC) == 0 ||
        !is_fifo_fd(received[0])) {
        errno = receive_errno ? receive_errno : EMFILE;
        return -1;
    }

    errno = 0;
    if (write(writer, "released", 8) != -1 || errno != EPIPE) {
        return -1;
    }
    return close(received[0]) | close(writer) | close(carrier[0]) |
           close(carrier[1]) | unlink(path);
}

int main(void) {
    if (signal(SIGPIPE, SIG_IGN) == SIG_ERR ||
        transferred_endpoint_survives_sender_close() < 0 ||
        transferred_writer_survives_sender_close() < 0 ||
        abandoned_endpoint_is_released() < 0 ||
        unreturnable_endpoint_is_released() < 0 ||
        reachable_socket_right_cycles_deliver() < 0 ||
        abandoned_socket_right_cycles_are_collected() < 0 ||
        receiver_control_truncation_installs_prefix_and_releases_excess() < 0 ||
        receiver_emfile_partially_installs_and_releases() < 0 ||
        transferred_fifo_path_survives_sender_close_and_unlink() < 0 ||
        transferred_fifo_reader_preserves_hangup_cohort() < 0 ||
        transferred_fifo_writer_survives_sender_close() < 0 ||
        transferred_fifo_read_write_survives_sender_close() < 0 ||
        discarded_fifo_references_are_released() < 0 ||
        fifo_emfile_installs_path_and_releases_reader() < 0) {
        perror("scm-rights-pipe-lifetime");
        return 1;
    }
    puts("PASS: SCM_RIGHTS owns pipe and FIFO references in flight and after receipt");
    return 0;
}
