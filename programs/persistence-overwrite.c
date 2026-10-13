#include <fcntl.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int fd = open("/state", O_RDWR);
    if (fd < 0) return 1;
    if (pwrite(fd, "XY", 2, 0) != 2) return 2;
    if ((argc < 2 || argv[1][0] != 'u') && fsync(fd) != 0) return 3;
    return close(fd) == 0 ? 0 : 4;
}
