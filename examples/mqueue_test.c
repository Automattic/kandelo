/**
 * POSIX message queues, end to end.
 *
 * WHY THIS EXISTS. `mq_timedsend`/`mq_timedreceive` had no guest-level test
 * anywhere in the repository. The kernel side was covered by Rust unit tests
 * in `crates/runtime-core/src/mqueue.rs`, and the only host-side cases
 * exercised a preflight that no longer exists — so the path a real program
 * actually takes was never run.
 *
 * What it pins is the EMSGSIZE rule, and specifically its ORDERING. POSIX
 * requires EMSGSIZE when a sent message exceeds the queue's `mq_msgsize`, and
 * when a receive capacity is SMALLER than it. Both must be decided from the
 * queue's own attribute, before anything sizes a buffer from the caller's
 * length — otherwise an oversized request fails as ENOMEM, or as EINVAL above
 * a transport's capacity, and the caller is told the wrong thing about its own
 * message.
 *
 * Runs unchanged on wasm32 and wasm64: `mq_attr` is 32 bytes on one and 64 on
 * the other, so the same source exercises both caller layouts.
 */
#include <errno.h>
#include <fcntl.h>
#include <mqueue.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define QUEUE_NAME "/kandelo_mq_test"
#define MSG_SIZE 64
#define MAX_MSG 4

static int failures;

static void check(int ok, const char *what) {
    if (ok) {
        printf("%s: ok\n", what);
    } else {
        printf("%s: FAIL (errno=%d)\n", what, errno);
        failures++;
    }
}

int main(void) {
    /* A stale queue from an earlier run must not change what this one sees. */
    mq_unlink(QUEUE_NAME);

    struct mq_attr attr;
    memset(&attr, 0, sizeof attr);
    attr.mq_maxmsg = MAX_MSG;
    attr.mq_msgsize = MSG_SIZE;

    mqd_t mq = mq_open(QUEUE_NAME, O_CREAT | O_EXCL | O_RDWR, 0600, &attr);
    if (mq == (mqd_t)-1) {
        perror("mq_open");
        return 1;
    }
    printf("mq_open: ok\n");

    /* The attributes come back through the caller-width `struct mq_attr`. */
    struct mq_attr read_back;
    memset(&read_back, 0, sizeof read_back);
    check(mq_getattr(mq, &read_back) == 0, "mq_getattr");
    check(read_back.mq_maxmsg == MAX_MSG, "mq_getattr maxmsg");
    check(read_back.mq_msgsize == MSG_SIZE, "mq_getattr msgsize");

    /* Ordinary round trip, with priority ordering. */
    check(mq_send(mq, "low", 3, 1) == 0, "mq_send low priority");
    check(mq_send(mq, "high", 4, 9) == 0, "mq_send high priority");

    char buf[MSG_SIZE];
    unsigned prio = 0;
    ssize_t got = mq_receive(mq, buf, sizeof buf, &prio);
    check(got == 4 && memcmp(buf, "high", 4) == 0 && prio == 9,
          "mq_receive returns the highest priority first");

    prio = 0;
    got = mq_receive(mq, buf, sizeof buf, &prio);
    check(got == 3 && memcmp(buf, "low", 3) == 0 && prio == 1,
          "mq_receive returns the remaining message");

    /* A zero-length message is a message: it must round-trip, and its
     * destination pointer must not be dereferenced for zero bytes. */
    check(mq_send(mq, "", 0, 0) == 0, "mq_send zero length");
    got = mq_receive(mq, buf, sizeof buf, NULL);
    check(got == 0, "mq_receive zero length");

    /*
     * EMSGSIZE, both directions. These are the two cases the ordering has to
     * get right, and each would report something else if the caller's length
     * sized a buffer first.
     */
    char oversized[MSG_SIZE + 1];
    memset(oversized, 'x', sizeof oversized);
    errno = 0;
    check(mq_send(mq, oversized, sizeof oversized, 0) == -1 && errno == EMSGSIZE,
          "mq_send above mq_msgsize is EMSGSIZE");

    check(mq_send(mq, "fits", 4, 0) == 0, "mq_send at capacity");
    errno = 0;
    check(mq_receive(mq, buf, MSG_SIZE - 1, NULL) == -1 && errno == EMSGSIZE,
          "mq_receive below mq_msgsize is EMSGSIZE");
    /* The refused receive must not have consumed the message. */
    got = mq_receive(mq, buf, sizeof buf, NULL);
    check(got == 4 && memcmp(buf, "fits", 4) == 0,
          "a refused receive leaves the message queued");

    /* O_NONBLOCK on an empty queue is EAGAIN, not a block. */
    check(mq_close(mq) == 0, "mq_close");
    mq = mq_open(QUEUE_NAME, O_RDWR | O_NONBLOCK);
    if (mq == (mqd_t)-1) {
        perror("mq_open nonblock");
        return 1;
    }
    errno = 0;
    check(mq_receive(mq, buf, sizeof buf, NULL) == -1 && errno == EAGAIN,
          "mq_receive on an empty non-blocking queue is EAGAIN");

    /* Fill the queue, then prove a full non-blocking send is EAGAIN too. */
    for (int i = 0; i < MAX_MSG; i++) {
        check(mq_send(mq, "m", 1, 0) == 0, "mq_send while filling");
    }
    errno = 0;
    check(mq_send(mq, "m", 1, 0) == -1 && errno == EAGAIN,
          "mq_send on a full non-blocking queue is EAGAIN");

    check(mq_close(mq) == 0, "mq_close nonblock");
    check(mq_unlink(QUEUE_NAME) == 0, "mq_unlink");

    if (failures == 0) {
        printf("ALL TESTS PASSED\n");
    } else {
        printf("FAILURES: %d\n", failures);
    }
    return failures;
}
