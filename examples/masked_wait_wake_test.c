/*
 * A ppoll()/pselect() that installs a temporary signal mask, woken by
 * another process.
 *
 * Three properties, each for both calls:
 *
 *   kill     A signal the temporary mask unblocks, sent while the call is
 *            blocked, interrupts it: EINTR, the handler ran, and the
 *            caller's mask is back.
 *
 *   race     The peer writes the pipe and THEN signals ("write, then
 *            kill"). POSIX lets the call return either way: EINTR if the
 *            signal is seen first, or the ready descriptor if the write is.
 *            In the second case the signal arrives after the caller's mask
 *            is restored and must stay pending, not vanish. Either way the
 *            handler runs exactly once by the time the caller unblocks the
 *            signal.
 *
 *   latency  Readiness from another process ends the wait promptly. The
 *            host used to hold every masked wait back by 50 ms after a
 *            readiness event; that cost a shell at a prompt (bash waits in
 *            a masked pselect6) up to 50 ms per keystroke. The median over
 *            several rounds must stay well under that.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum wait_api { API_PPOLL, API_PSELECT, API_COUNT };
enum { RACE_ROUNDS = 6, LATENCY_ROUNDS = 9 };
/* Half the removed delay: loose enough for a loaded machine, and every
 * round of a 50 ms grace period would exceed it. */
enum { LATENCY_LIMIT_US = 25000 };

static volatile sig_atomic_t usr1_count;

static void on_usr1(int signum) {
    (void)signum;
    usr1_count++;
}

static void require(int ok, const char *what) {
    if (!ok) {
        fprintf(stderr, "FAIL %s (errno %d: %s)\n", what, errno, strerror(errno));
        exit(1);
    }
}

static const char *api_name(enum wait_api api) {
    return api == API_PPOLL ? "ppoll" : "pselect";
}

static int64_t now_us(void) {
    struct timespec ts;
    require(clock_gettime(CLOCK_MONOTONIC, &ts) == 0, "clock_gettime");
    return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

/* Block in the chosen call with `mask` installed. Returns its result with
 * errno intact; a "ready" result that does not name `fd` is a failure. */
static int masked_wait(enum wait_api api, int fd, const sigset_t *mask) {
    if (api == API_PPOLL) {
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int result = ppoll(&pfd, 1, NULL, mask);
        if (result == 1) require((pfd.revents & POLLIN) != 0, "ppoll POLLIN");
        return result;
    }
    fd_set readable;
    FD_ZERO(&readable);
    FD_SET(fd, &readable);
    int result = pselect(fd + 1, &readable, NULL, NULL, NULL, mask);
    if (result == 1) require(FD_ISSET(fd, &readable), "pselect readable");
    return result;
}

static void require_mask(const sigset_t *expected, const char *what) {
    sigset_t current;
    require(sigprocmask(SIG_SETMASK, NULL, &current) == 0, "sigprocmask query");
    for (int sig = 1; sig < 65; sig++) {
        int want = sigismember(expected, sig);
        if (want < 0) continue;
        if (sigismember(&current, sig) != want) {
            fprintf(stderr, "FAIL %s: signal %d mask bit differs\n", what, sig);
            exit(1);
        }
    }
}

enum peer_action { PEER_WRITE, PEER_KILL, PEER_WRITE_THEN_KILL };

/* Fork a peer that waits for the go byte, gives the parent time to block,
 * then acts. The written payload is the peer's CLOCK_MONOTONIC reading
 * taken just before the write. */
static pid_t start_peer(int go_fd, int data_fd, enum peer_action action,
                        useconds_t settle_us) {
    pid_t parent = getpid();
    pid_t pid = fork();
    require(pid >= 0, "fork");
    if (pid != 0) return pid;
    char go;
    if (read(go_fd, &go, 1) != 1) _exit(10);
    usleep(settle_us);
    if (action != PEER_KILL) {
        int64_t stamp = now_us();
        if (write(data_fd, &stamp, sizeof stamp) != (ssize_t)sizeof stamp) _exit(11);
    }
    if (action != PEER_WRITE && kill(parent, SIGUSR1) != 0) _exit(12);
    _exit(0);
}

static void reap(pid_t pid) {
    int status;
    require(waitpid(pid, &status, 0) == pid, "waitpid");
    require(WIFEXITED(status) && WEXITSTATUS(status) == 0, "peer exit status");
}

static int64_t read_stamp(int fd) {
    int64_t stamp;
    require(read(fd, &stamp, sizeof stamp) == (ssize_t)sizeof stamp, "read stamp");
    return stamp;
}

int main(void) {
    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_handler = on_usr1;
    sigemptyset(&action.sa_mask);
    require(sigaction(SIGUSR1, &action, NULL) == 0, "sigaction");

    sigset_t usr1;
    sigemptyset(&usr1);
    sigaddset(&usr1, SIGUSR1);
    require(sigprocmask(SIG_BLOCK, &usr1, NULL) == 0, "block SIGUSR1");
    sigset_t original;
    require(sigprocmask(SIG_SETMASK, NULL, &original) == 0, "save mask");
    sigset_t during_wait = original;
    sigdelset(&during_wait, SIGUSR1);

    for (enum wait_api api = API_PPOLL; api < API_COUNT; api++) {
        int data[2], go[2];

        /* kill: a signal sent while blocked interrupts the call. */
        require(pipe(data) == 0 && pipe(go) == 0, "pipe");
        usr1_count = 0;
        pid_t peer = start_peer(go[0], data[1], PEER_KILL, 20000);
        require(write(go[1], "g", 1) == 1, "go");
        int result = masked_wait(api, data[0], &during_wait);
        int saved_errno = errno;
        require(result == -1 && saved_errno == EINTR, "kill interrupts with EINTR");
        require(usr1_count == 1, "kill ran the handler once");
        require_mask(&original, "mask restored after EINTR");
        reap(peer);
        close(data[0]); close(data[1]); close(go[0]); close(go[1]);
        printf("MASKED_WAIT_KILL api=%s ok\n", api_name(api));

        /* race: write, then kill. Either outcome; the signal is never lost. */
        int interrupted = 0, ready = 0;
        for (int round = 0; round < RACE_ROUNDS; round++) {
            require(pipe(data) == 0 && pipe(go) == 0, "pipe");
            usr1_count = 0;
            peer = start_peer(go[0], data[1], PEER_WRITE_THEN_KILL, 20000);
            require(write(go[1], "g", 1) == 1, "go");
            result = masked_wait(api, data[0], &during_wait);
            saved_errno = errno;
            require_mask(&original, "mask restored after the race");
            /* After the reap the peer's kill() has happened. */
            reap(peer);
            if (result == -1) {
                require(saved_errno == EINTR, "race error is EINTR");
                require(usr1_count == 1, "EINTR ran the handler once");
                interrupted++;
            } else {
                require(result == 1, "race result is one ready descriptor");
                sigset_t pending;
                require(sigpending(&pending) == 0, "sigpending");
                require(usr1_count + sigismember(&pending, SIGUSR1) == 1,
                        "a late signal is handled or pending, exactly once");
                ready++;
            }
            /* The write happened before the kill, so the data is there in
             * both outcomes and nothing consumed it. */
            read_stamp(data[0]);
            require(sigprocmask(SIG_UNBLOCK, &usr1, NULL) == 0, "unblock");
            require(sigprocmask(SIG_BLOCK, &usr1, NULL) == 0, "reblock");
            require(usr1_count == 1, "the handler ran exactly once");
            close(data[0]); close(data[1]); close(go[0]); close(go[1]);
        }
        printf("MASKED_WAIT_RACE api=%s eintr=%d ready=%d\n",
               api_name(api), interrupted, ready);

        /* latency: readiness from another process ends the wait promptly. */
        int64_t samples[LATENCY_ROUNDS];
        for (int round = 0; round < LATENCY_ROUNDS; round++) {
            require(pipe(data) == 0 && pipe(go) == 0, "pipe");
            peer = start_peer(go[0], data[1], PEER_WRITE, 10000);
            require(write(go[1], "g", 1) == 1, "go");
            result = masked_wait(api, data[0], &during_wait);
            int64_t returned = now_us();
            require(result == 1, "readiness ends the wait");
            int64_t written = read_stamp(data[0]);
            require(returned >= written, "monotonic clock agrees across processes");
            samples[round] = returned - written;
            reap(peer);
            close(data[0]); close(data[1]); close(go[0]); close(go[1]);
        }
        for (int i = 1; i < LATENCY_ROUNDS; i++) {
            for (int j = i; j > 0 && samples[j - 1] > samples[j]; j--) {
                int64_t swap = samples[j];
                samples[j] = samples[j - 1];
                samples[j - 1] = swap;
            }
        }
        int64_t median = samples[LATENCY_ROUNDS / 2];
        printf("MASKED_WAIT_LATENCY api=%s median_us=%lld max_us=%lld\n",
               api_name(api), (long long)median,
               (long long)samples[LATENCY_ROUNDS - 1]);
        if (median >= LATENCY_LIMIT_US) {
            fprintf(stderr, "FAIL %s readiness latency median %lld us >= %d us\n",
                    api_name(api), (long long)median, LATENCY_LIMIT_US);
            return 1;
        }
    }
    puts("MASKED_WAIT_WAKE_PASS");
    return 0;
}
