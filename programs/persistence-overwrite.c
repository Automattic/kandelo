#include <fcntl.h>
#include <unistd.h>

static unsigned char large_write[2 * 1024 * 1024];

int main(int argc, char **argv) {
    if (argc >= 2 && argv[1][0] == 'l') {
        int large_fd = open("/large", O_RDWR);
        if (large_fd < 0) return 5;
        for (size_t index = 0; index < sizeof(large_write); index++) {
            large_write[index] = (unsigned char)((index / 4096) ^ index);
        }
        if (pwrite(large_fd, large_write, sizeof(large_write), 13) != (ssize_t)sizeof(large_write)) return 6;
        if (fsync(large_fd) != 0) return 7;
        return close(large_fd) == 0 ? 0 : 8;
    }
    int fd = open("/state", O_RDWR);
    if (fd < 0) return 1;
    if (pwrite(fd, "XY", 2, 0) != 2) return 2;
    if ((argc < 2 || argv[1][0] != 'u') && fsync(fd) != 0) return 3;
    return close(fd) == 0 ? 0 : 4;
}
