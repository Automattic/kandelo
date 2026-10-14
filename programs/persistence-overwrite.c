#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static unsigned char large_write[2 * 1024 * 1024];
static unsigned char verify_buffer[4096];

int main(int argc, char **argv) {
    int verify_tail = argc >= 2 && strcmp(argv[1], "verify-large-tail") == 0;
    int write_tail = argc >= 2 && strcmp(argv[1], "large-tail") == 0;
    if (verify_tail || write_tail || (argc >= 2 && strcmp(argv[1], "large") == 0)) {
        int large_fd = open("/large", O_RDWR);
        if (large_fd < 0) return 5;
        off_t offset = 13;
        if (verify_tail || write_tail) {
            struct stat metadata;
            if (fstat(large_fd, &metadata) != 0 || metadata.st_size < (off_t)sizeof(large_write) + 13) return 9;
            offset = metadata.st_size - (off_t)sizeof(large_write) - 13;
        }
        for (size_t index = 0; index < sizeof(large_write); index++) {
            large_write[index] = (unsigned char)((index / 4096) ^ index);
        }
        if (verify_tail) {
            for (size_t index = 0; index < sizeof(large_write); index += sizeof(verify_buffer)) {
                if (pread(large_fd, verify_buffer, sizeof(verify_buffer), offset + (off_t)index) != (ssize_t)sizeof(verify_buffer)) return 10;
                if (memcmp(verify_buffer, large_write + index, sizeof(verify_buffer)) != 0) return 11;
            }
        } else {
            if (pwrite(large_fd, large_write, sizeof(large_write), offset) != (ssize_t)sizeof(large_write)) return 6;
            if (fsync(large_fd) != 0) return 7;
        }
        return close(large_fd) == 0 ? 0 : 8;
    }
    int fd = open("/state", O_RDWR);
    if (fd < 0) return 1;
    if (pwrite(fd, "XY", 2, 0) != 2) return 2;
    if ((argc < 2 || argv[1][0] != 'u') && fsync(fd) != 0) return 3;
    return close(fd) == 0 ? 0 : 4;
}
