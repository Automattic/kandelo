/* Test program: assert that sendto() to a non-loopback IPv4 address
 * returns ENETUNREACH on the Node host.
 *
 * The kernel's UDP code routes loopback (127.0.0.0/8) through the
 * intra-kernel dgram_queue and routes everything else out via the
 * host's `host_send_dgram` import. The browser host overrides this
 * import to forward onto an RTCDataChannel; the Node host leaves the
 * default in place, which returns -ENETUNREACH (-101) so that
 * sys_sendto can surface a real errno to userspace. This program
 * pins that contract: the Node host has no UDP egress beyond
 * loopback.
 *
 * Pairs with host/test/sendto-non-loopback.test.ts (DA #3 from the
 * 2026-05-20 session-13 audit).
 */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <netinet/in.h>

int main(void) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }

    /* Bind to an ephemeral port (port=0). The kernel needs a bound
     * socket to record src_port; without it sendto returns EINVAL
     * before ever reaching the routing decision. */
    struct sockaddr_in bind_addr;
    memset(&bind_addr, 0, sizeof(bind_addr));
    bind_addr.sin_family = AF_INET;
    bind_addr.sin_port = 0;
    bind_addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(fd, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0) {
        perror("bind");
        close(fd);
        return 1;
    }

    struct sockaddr_in dst;
    memset(&dst, 0, sizeof(dst));
    dst.sin_family = AF_INET;
    dst.sin_port = htons(1234);
    /* 10.0.0.1 — a non-loopback, non-zero, non-broadcast IPv4 that
     * the kernel routes via host_send_dgram. */
    dst.sin_addr.s_addr = htonl((10u << 24) | 1u);

    const char *payload = "ping";
    ssize_t n = sendto(fd, payload, 4, 0, (struct sockaddr *)&dst, sizeof(dst));
    int saved_errno = errno;

    close(fd);

    if (n >= 0) {
        printf("FAIL: sendto unexpectedly succeeded (n=%zd)\n", n);
        return 1;
    }
    if (saved_errno != ENETUNREACH) {
        printf("FAIL: errno=%d (%s), expected ENETUNREACH(%d)\n",
               saved_errno, strerror(saved_errno), ENETUNREACH);
        return 1;
    }
    printf("PASS: sendto returned ENETUNREACH\n");
    return 0;
}
