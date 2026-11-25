#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

enum { bits_per_word = sizeof(unsigned long) * CHAR_BIT };

static void set_bit(unsigned long *set, int fd)
{
    set[fd / bits_per_word] |= 1UL << (fd % bits_per_word);
}

static int has_bit(const unsigned long *set, int fd)
{
    return (set[fd / bits_per_word] >> (fd % bits_per_word)) & 1;
}

static void check(int condition, const char *operation)
{
    if (!condition) {
        fprintf(stderr, "%s failed (errno %d)\n", operation, errno);
        exit(1);
    }
}

int main(int argc, char **argv)
{
    // The optional mode takes the same operation beyond the fixed mailbox.
    int fd = argc > 1 && strcmp(argv[1], "reserved") == 0 ? 200000 : FD_SETSIZE;
    struct rlimit limits;
    check(getrlimit(RLIMIT_NOFILE, &limits) == 0, "getrlimit");
    rlim_t original_soft = limits.rlim_cur;
    if (limits.rlim_max <= (rlim_t)fd)
        limits.rlim_max = fd + 8;
    limits.rlim_cur = fd + 8;
    check(setrlimit(RLIMIT_NOFILE, &limits) == 0, "raise descriptor limit");

    int pair[2];
    check(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0, "socketpair");
    check(fcntl(pair[0], F_DUPFD, fd) == fd, "duplicate at high descriptor");
    limits.rlim_cur = original_soft;
    check(setrlimit(RLIMIT_NOFILE, &limits) == 0, "restore soft descriptor limit");

    size_t words = (size_t)fd / bits_per_word + 1;
    unsigned long *reads = calloc(words, sizeof *reads);
    unsigned long *writes = calloc(words, sizeof *writes);
    unsigned long *errors = calloc(words, sizeof *errors);
    check(reads && writes && errors, "allocate fd bitmaps");
    set_bit(reads, fd);
    set_bit(reads, pair[1]);
    set_bit(writes, fd);
    set_bit(errors, fd);
    check(write(pair[1], "x", 1) == 1, "queue stream data");

    struct timeval now = {0};
    check(select(fd + 1, (fd_set *)reads, (fd_set *)writes, (fd_set *)errors, &now) == 2,
          "select counts read and write separately");
    check(has_bit(reads, fd) && !has_bit(reads, pair[1]) &&
          has_bit(writes, fd) && !has_bit(errors, fd), "select result sets");

    sigset_t temporary, before, after;
    check(sigemptyset(&temporary) == 0 && sigaddset(&temporary, SIGUSR1) == 0,
          "prepare pselect mask");
    check(sigprocmask(SIG_SETMASK, NULL, &before) == 0, "read original mask");
    struct timespec instant = {0};
    check(pselect(fd + 1, (fd_set *)reads, NULL, NULL, &instant, &temporary) == 1,
          "pselect high descriptor");
    char byte;
    check(read(fd, &byte, 1) == 1 && byte == 'x', "read high descriptor");

    struct timespec timeout = {0, 20000000};
    check(pselect(fd + 1, (fd_set *)reads, NULL, NULL, &timeout, &temporary) == 0 &&
          !has_bit(reads, fd), "pselect timeout clears readiness");
    check(sigprocmask(SIG_SETMASK, NULL, &after) == 0 &&
          sigismember(&before, SIGUSR1) == sigismember(&after, SIGUSR1),
          "restore pselect signal mask");

    set_bit(reads, fd);
    check(close(fd) == 0, "close high descriptor");
    errno = 0;
    check(select(fd + 1, (fd_set *)reads, NULL, NULL, &now) == -1 && errno == EBADF,
          "select closed descriptor");
    check(has_bit(reads, fd), "select error leaves the input set intact");
    errno = 0;
    check(pselect(fd + 1, (fd_set *)reads, NULL, NULL, &instant, &temporary) == -1 &&
          errno == EBADF && has_bit(reads, fd), "pselect closed descriptor");
    check(close(pair[0]) == 0 && close(pair[1]) == 0, "close socketpair");
    free(reads);
    free(writes);
    free(errors);
    puts("wide select and pselect ok");
    return 0;
}
