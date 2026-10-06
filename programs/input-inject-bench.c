/*
 * Throughput reader for the evdev injection benchmark
 * (benchmarks/suites/input-injection.ts). Opens /dev/input/event0, then
 * drains it in waves: read `records_per_wave` records, acknowledge the
 * wave on stdout, repeat `waves` times. The host injects one wave's worth
 * of records between acknowledgements, so the per-OFD ring (cap 1024)
 * never overflows and the record count stays exact — the benchmark can
 * therefore attribute the wall-clock difference purely to how the host
 * crosses the worker boundary (per-record vs. batched per SYN_REPORT).
 *
 * argv: input-inject-bench <records_per_wave> <waves>
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

struct wpk_event {
    int64_t tv_sec;
    int32_t tv_usec;
    int32_t _pad;
    uint16_t ev_type;
    uint16_t code;
    int32_t value;
};

_Static_assert(sizeof(struct wpk_event) == 24, "WpkInputEvent must be 24 bytes");

int main(int argc, char **argv) {
    long per_wave = argc > 1 ? atol(argv[1]) : 300;
    long waves = argc > 2 ? atol(argv[2]) : 100;

    int fd = open("/dev/input/event0", O_RDONLY);
    if (fd < 0) {
        perror("open event0");
        return 1;
    }
    /* Signal readiness so the host injects only after the OFD exists. */
    printf("ready\n");
    fflush(stdout);

    struct wpk_event ev;
    for (long w = 0; w < waves; w++) {
        long seen = 0;
        while (seen < per_wave) {
            ssize_t n = read(fd, &ev, sizeof(ev));
            if (n == (ssize_t)sizeof(ev)) {
                seen++;
            }
            /* Ok(0) is the kernel's "nothing yet, retry" for a blocking
             * evdev read; spin until the host injects the next record. */
        }
        printf("wave %ld\n", w);
        fflush(stdout);
    }
    printf("done\n");
    fflush(stdout);
    return 0;
}
