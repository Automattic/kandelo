/* sysv-shm-bench.c — Targeted cost of the SysV shared-memory coherence path.
 *
 * WHY THIS EXISTS, AND WHY A GENERAL SYSCALL BENCHMARK CANNOT REPLACE IT.
 *
 * The shared-mapping subsystem returns immediately at a syscall boundary when
 * the process owns no shared state, and skips any attachment with no live
 * peer. A general syscall suite therefore exercises only the early-out and
 * reports "no change" — a true result about the early-out that says nothing
 * about the coherence work itself. Reaching that work needs a process holding
 * a real SysV attachment with a live peer, crossing boundaries in a loop.
 *
 * Two cases, because they move in opposite directions and averaging them would
 * hide both:
 *
 *   clean — a peer exists but nobody writes. Each boundary must still decide
 *           there is nothing to publish. That decision costs a comparison of
 *           the attachment against its snapshot.
 *
 *   dirty — the parent writes a few bytes every iteration, so each boundary
 *           publishes changed runs into the segment and imports the
 *           authoritative result back.
 *
 * The child is a live peer that never writes: its only job is to make
 * `has_peer` true so the parent's boundaries do real work. It parks on a pipe
 * read so it consumes no CPU while the parent is timed.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/time.h>
#include <sys/wait.h>

#define SEGMENT_BYTES (256 * 1024)
#define ITERATIONS 2000

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

int main(void) {
    int shmid = shmget(IPC_PRIVATE, SEGMENT_BYTES, IPC_CREAT | 0600);
    if (shmid < 0) {
        perror("shmget");
        return 1;
    }

    /* The child signals readiness on `ready`, and the parent releases it on
     * `done`. Without the handshake the parent could finish timing before the
     * child ever attached, and would have measured the sole-observer path. */
    int ready[2], done[2];
    if (pipe(ready) != 0 || pipe(done) != 0) {
        perror("pipe");
        return 1;
    }

    pid_t child = fork();
    if (child < 0) {
        perror("fork");
        return 1;
    }
    if (child == 0) {
        close(ready[0]);
        close(done[1]);
        char *peer = shmat(shmid, NULL, 0);
        if (peer == (char *)-1) {
            _exit(1);
        }
        /* Touch one byte so the attachment is unambiguously live, then park. */
        volatile char sink = peer[0];
        (void)sink;
        char go = 1;
        if (write(ready[1], &go, 1) != 1) {
            _exit(1);
        }
        char stop;
        (void)read(done[0], &stop, 1);
        shmdt(peer);
        _exit(0);
    }

    close(ready[1]);
    close(done[0]);
    char go;
    if (read(ready[0], &go, 1) != 1) {
        fprintf(stderr, "child never attached\n");
        return 1;
    }

    char *mine = shmat(shmid, NULL, 0);
    if (mine == (char *)-1) {
        perror("shmat");
        return 1;
    }

    /* Warm up: the first boundaries after an attach do one-off work. */
    for (int i = 0; i < 50; i++) {
        getpid();
    }

    long long t0 = now_us();
    for (int i = 0; i < ITERATIONS; i++) {
        getpid();
    }
    long long t1 = now_us();
    double clean_us = (double)(t1 - t0) / ITERATIONS;

    long long t2 = now_us();
    for (int i = 0; i < ITERATIONS; i++) {
        /* Dirty a byte in a different page each iteration so the publication
         * is real work rather than a repeatedly identical run. */
        mine[(i * 4096) % SEGMENT_BYTES] = (char)(i & 0xff);
        getpid();
    }
    long long t3 = now_us();
    double dirty_us = (double)(t3 - t2) / ITERATIONS;

    long long t4 = now_us();
    for (int i = 0; i < 200; i++) {
        char *extra = shmat(shmid, NULL, 0);
        if (extra == (char *)-1) {
            perror("shmat churn");
            return 1;
        }
        shmdt(extra);
    }
    long long t5 = now_us();
    double attach_us = (double)(t5 - t4) / 200;

    char stop = 1;
    (void)write(done[1], &stop, 1);
    int status = 0;
    waitpid(child, &status, 0);
    shmdt(mine);
    shmctl(shmid, IPC_RMID, NULL);

    printf("sysv_boundary_clean_us=%f\n", clean_us);
    printf("sysv_boundary_dirty_us=%f\n", dirty_us);
    printf("sysv_attach_detach_us=%f\n", attach_us);
    printf("sysv_segment_bytes=%d\n", SEGMENT_BYTES);
    return 0;
}
