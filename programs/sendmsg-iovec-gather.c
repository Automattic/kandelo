// sendmsg() gathers every iovec into one byte stream, and recvmsg()
// scatters what it reads back across them.
//
// Both used to read iov[0] alone. sd-bus (basu) fronts its auth lines with
// an empty iovec, so a send returned 0 forever and mako's bus connection
// livelocked; a receive fronted the same way returned 0, which the caller
// reads as EOF.
//
// Expected output on PASS:
//   AUTH: n=15
//   GATHER: foobarbaz
//   SCATTER: quux|corge
//   LEADING_EMPTY: waldo
//   IOV_MAX_OK: garply
//   IOV_MAX: EMSGSIZE
//   PASS

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int fds[2];

static ssize_t send_iov(struct iovec *iov, int n) {
    struct msghdr msg;
    memset(&msg, 0, sizeof(msg));
    msg.msg_iov = iov;
    msg.msg_iovlen = n;
    return sendmsg(fds[0], &msg, 0);
}

static ssize_t recv_iov(struct iovec *iov, int n) {
    struct msghdr msg;
    memset(&msg, 0, sizeof(msg));
    msg.msg_iov = iov;
    msg.msg_iovlen = n;
    return recvmsg(fds[1], &msg, 0);
}

int main(void) {
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0) {
        printf("FAIL: socketpair errno=%d\n", errno);
        return 1;
    }

    // The sd-bus shape: an empty iovec ahead of the payload.
    char empty[1];
    const char *auth = "AUTH EXTERNAL\r\n";
    struct iovec out[3] = {
        {.iov_base = empty, .iov_len = 0},
        {.iov_base = (void *)auth, .iov_len = strlen(auth)},
    };
    ssize_t n = send_iov(out, 2);
    if (n != (ssize_t)strlen(auth)) {
        printf("FAIL: auth send returned %zd errno=%d\n", n, errno);
        return 1;
    }
    char got[32] = {0};
    struct iovec in1 = {.iov_base = got, .iov_len = strlen(auth)};
    n = recv_iov(&in1, 1);
    if (n != (ssize_t)strlen(auth) || strcmp(got, auth) != 0) {
        printf("FAIL: auth recv returned %zd got=\"%s\"\n", n, got);
        return 1;
    }
    printf("AUTH: n=%zd\n", n);

    // Three non-empty iovecs become one stream.
    out[0] = (struct iovec){.iov_base = (void *)"foo", .iov_len = 3};
    out[1] = (struct iovec){.iov_base = (void *)"bar", .iov_len = 3};
    out[2] = (struct iovec){.iov_base = (void *)"baz", .iov_len = 3};
    if (send_iov(out, 3) != 9) {
        printf("FAIL: gather send errno=%d\n", errno);
        return 1;
    }
    memset(got, 0, sizeof(got));
    in1.iov_len = 9;
    if (recv_iov(&in1, 1) != 9 || strcmp(got, "foobarbaz") != 0) {
        printf("FAIL: gather recv got=\"%s\"\n", got);
        return 1;
    }
    printf("GATHER: %s\n", got);

    // One stream fills several receive iovecs in order.
    out[0] = (struct iovec){.iov_base = (void *)"quuxcorge", .iov_len = 9};
    if (send_iov(out, 1) != 9) {
        printf("FAIL: scatter send errno=%d\n", errno);
        return 1;
    }
    char head[5] = {0}, tail[6] = {0};
    struct iovec in2[2] = {
        {.iov_base = head, .iov_len = 4},
        {.iov_base = tail, .iov_len = 5},
    };
    if (recv_iov(in2, 2) != 9 ||
        strcmp(head, "quux") != 0 || strcmp(tail, "corge") != 0) {
        printf("FAIL: scatter recv head=\"%s\" tail=\"%s\"\n", head, tail);
        return 1;
    }
    printf("SCATTER: %s|%s\n", head, tail);

    // An empty leading receive iovec is not end of stream.
    out[0] = (struct iovec){.iov_base = (void *)"waldo", .iov_len = 5};
    if (send_iov(out, 1) != 5) {
        printf("FAIL: leading-empty send errno=%d\n", errno);
        return 1;
    }
    memset(got, 0, sizeof(got));
    in2[0] = (struct iovec){.iov_base = empty, .iov_len = 0};
    in2[1] = (struct iovec){.iov_base = got, .iov_len = 5};
    n = recv_iov(in2, 2);
    if (n != 5 || strcmp(got, "waldo") != 0) {
        printf("FAIL: leading-empty recv returned %zd got=\"%s\"\n", n, got);
        return 1;
    }
    printf("LEADING_EMPTY: %s\n", got);

    // Exactly IOV_MAX iovecs still send; one more fails with EMSGSIZE,
    // not the EINVAL that readv and writev return for that overflow.
    static struct iovec over[IOV_MAX + 1];
    for (int i = 0; i < IOV_MAX + 1; i++) {
        over[i] = (struct iovec){.iov_base = empty, .iov_len = 0};
    }
    over[IOV_MAX - 1] = (struct iovec){.iov_base = (void *)"garply", .iov_len = 6};
    if (send_iov(over, IOV_MAX) != 6) {
        printf("FAIL: send at IOV_MAX errno=%d\n", errno);
        return 1;
    }
    memset(got, 0, sizeof(got));
    over[IOV_MAX - 1] = (struct iovec){.iov_base = got, .iov_len = 6};
    if (recv_iov(over, IOV_MAX) != 6 || strcmp(got, "garply") != 0) {
        printf("FAIL: recv at IOV_MAX got=\"%s\"\n", got);
        return 1;
    }
    printf("IOV_MAX_OK: %s\n", got);

    errno = 0;
    if (send_iov(over, IOV_MAX + 1) != -1 || errno != EMSGSIZE) {
        printf("FAIL: send over IOV_MAX errno=%d\n", errno);
        return 1;
    }
    errno = 0;
    if (recv_iov(over, IOV_MAX + 1) != -1 || errno != EMSGSIZE) {
        printf("FAIL: recv over IOV_MAX errno=%d\n", errno);
        return 1;
    }
    printf("IOV_MAX: EMSGSIZE\n");

    printf("PASS\n");
    return 0;
}
