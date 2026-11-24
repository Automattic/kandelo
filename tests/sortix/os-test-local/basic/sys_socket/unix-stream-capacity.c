#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <unistd.h>

enum { pair_count = 768, stream_capacity = 65536 };

static int pairs[pair_count][2];
static unsigned char burst[stream_capacity + 1];
static unsigned char received[stream_capacity];

int main(void)
{
    struct rlimit limits;
    if (getrlimit(RLIMIT_NOFILE, &limits) < 0)
        return 1;
    if (limits.rlim_cur < 2 * pair_count + 3) {
        limits.rlim_cur = 2048;
        if (setrlimit(RLIMIT_NOFILE, &limits) < 0)
            return 2;
    }

    for (int i = 0; i < pair_count; ++i) {
        if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0, pairs[i]) < 0) {
            fprintf(stderr, "socketpair %d failed with errno %d\n", i, errno);
            return 3;
        }
    }
    for (int i = 0; i < pair_count; ++i) {
        unsigned char marker = i;
        unsigned char reply = ~marker;
        unsigned char byte;
        if (write(pairs[i][0], &marker, 1) != 1 ||
            write(pairs[i][1], &reply, 1) != 1 ||
            read(pairs[i][1], &byte, 1) != 1 || byte != marker ||
            read(pairs[i][0], &byte, 1) != 1 || byte != reply)
            return 4;
    }

    for (size_t i = 0; i < sizeof burst; ++i)
        burst[i] = i * 7;
    int sender = pairs[pair_count - 1][0];
    int receiver = pairs[pair_count - 1][1];
    if (write(sender, burst, sizeof burst) != stream_capacity ||
        write(sender, burst, 1) != -1 || errno != EAGAIN)
        return 5;
    struct pollfd ready[] = {{sender, POLLOUT, 0}, {receiver, POLLIN, 0}};
    if (poll(ready, 2, 0) != 1 || ready[0].revents || ready[1].revents != POLLIN)
        return 6;
    if (read(receiver, received, sizeof received) != stream_capacity)
        return 7;
    for (size_t i = 0; i < sizeof received; ++i) {
        if (received[i] != burst[i])
            return 8;
    }
    if (poll(ready, 2, 0) != 1 || ready[0].revents != POLLOUT || ready[1].revents)
        return 9;

    for (int i = 0; i < pair_count; ++i) {
        if (close(pairs[i][0]) < 0 || close(pairs[i][1]) < 0)
            return 10;
    }
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pairs[0]) < 0 ||
        close(pairs[0][0]) < 0 || close(pairs[0][1]) < 0)
        return 11;
    puts("Unix stream capacity ok");
    return 0;
}
