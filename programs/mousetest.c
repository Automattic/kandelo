/*
 * mousetest — open /dev/input/mice, print "ready\n", then read PS/2
 * packets and emit one stdout line per packet until `target` packets
 * have arrived (default 3, or argv[1]).
 *
 * Used by host/test/mouse-integration.test.ts to verify the kernel
 * routes injected mouse events into a process via `read()` on
 * /dev/input/mice. Each line:
 *
 *     pkt <byte0-hex> <signed-dx> <signed-dy>
 *
 * The harness calls kernel.mouse.inject(...) after seeing "ready\n",
 * then asserts the lines arrive in order with the expected deltas.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int target = (argc > 1) ? atoi(argv[1]) : 3;
    if (target <= 0) target = 3;

    int fd = open("/dev/input/mice", O_RDONLY | O_NONBLOCK);
    if (fd < 0) {
        perror("open /dev/input/mice");
        return 1;
    }

    write(1, "ready\n", 6);

    int got = 0;
    while (got < target) {
        uint8_t pkt[3];
        ssize_t n = read(fd, pkt, sizeof(pkt));
        if (n == 3) {
            printf("pkt %02x %d %d\n",
                   pkt[0], (int)(int8_t)pkt[1], (int)(int8_t)pkt[2]);
            fflush(stdout);
            got++;
        } else if (n < 0 && errno != EAGAIN) {
            perror("read /dev/input/mice");
            close(fd);
            return 1;
        } else {
            /* No data yet — yield briefly and retry. The kernel wakes
             * blocked retries when host_inject_mouse_event runs, but
             * a small sleep keeps the busy-loop bounded if the harness
             * is slow to inject. */
            usleep(1000);
        }
    }

    close(fd);
    return 0;
}
