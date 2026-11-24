#include <fcntl.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

int main(void)
{
    char buffer[8];
    int fd = open("/probe", O_RDONLY);
    if (fd < 0)
        return 1;
    if (read(fd, buffer, sizeof buffer) != sizeof buffer ||
        memcmp(buffer, "kandelo\n", sizeof buffer) != 0 || close(fd) != 0)
        return 2;

    const struct timespec delay = { .tv_nsec = 10000000 };
    if (nanosleep(&delay, 0) != 0)
        return 3;
    return 0;
}
