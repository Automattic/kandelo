#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static unsigned char large_write[2 * 1024 * 1024];
static unsigned char verify_buffer[4096];

int main(int argc, char **argv) {
    int resize = argc >= 2 && strcmp(argv[1], "resize") == 0;
    int verify_resize = argc >= 2 && strcmp(argv[1], "verify-resize") == 0;
    int verify_zero = argc >= 2 && strcmp(argv[1], "verify-zero") == 0;
    if (resize || verify_resize || verify_zero) {
        int fd = open("/state", O_RDWR | (resize ? O_TRUNC : 0));
        if (fd < 0) return 19;
        off_t offset = 8LL * 1024 * 1024 * 1024 + 7;
        if (resize) {
            struct stat metadata;
            if (fstat(fd, &metadata) != 0 || metadata.st_size != 0) return 20;
            if (pwrite(fd, "GROW", 4, offset) != 4) return 21;
        } else {
            struct stat metadata;
            if (fstat(fd, &metadata) != 0 || metadata.st_size != offset + 4) return 22;
            unsigned char prefix[8];
            if (pread(fd, prefix, sizeof(prefix), 0) != (ssize_t)sizeof(prefix)) return 30;
            if (memcmp(prefix, "\0\0\0\0\0\0\0\0", sizeof(prefix)) != 0) return 31;
            unsigned char bytes[4];
            if (pread(fd, bytes, sizeof(bytes), offset) != (ssize_t)sizeof(bytes)) return 23;
            if (verify_resize && memcmp(bytes, "GROW", 4) != 0) return 24;
            if (verify_zero && memcmp(bytes, "\0\0\0\0", 4) != 0) return 25;
            if (verify_resize) {
                if (ftruncate(fd, 2) != 0) return 26;
                if (ftruncate(fd, offset + 4) != 0) return 27;
            }
        }
        if (fsync(fd) != 0) return 28;
        return close(fd) == 0 ? 0 : 29;
    }
    int verify_many = argc >= 2 && strcmp(argv[1], "verify-many") == 0;
    int write_many = argc >= 2 && strcmp(argv[1], "many") == 0;
    if (verify_many || write_many) {
        int large_fd = open("/large", O_RDWR);
        if (large_fd < 0) return 12;
        struct stat metadata;
        if (fstat(large_fd, &metadata) != 0 || metadata.st_size < 32 * 1024 * 1024) return 13;
        for (int chunk = 0; chunk < 16; chunk++) {
            for (size_t index = 0; index < sizeof(large_write); index++) {
                large_write[index] = (unsigned char)((index / 4096) ^ index ^ chunk ^ 0x5a);
            }
            off_t offset = (off_t)chunk * (off_t)sizeof(large_write);
            if (verify_many) {
                for (size_t index = 0; index < sizeof(large_write); index += sizeof(verify_buffer)) {
                    if (pread(large_fd, verify_buffer, sizeof(verify_buffer), offset + (off_t)index) != (ssize_t)sizeof(verify_buffer)) return 14;
                    if (memcmp(verify_buffer, large_write + index, sizeof(verify_buffer)) != 0) return 15;
                }
            } else if (pwrite(large_fd, large_write, sizeof(large_write), offset) != (ssize_t)sizeof(large_write)) {
                return 16;
            }
        }
        if (!verify_many && fsync(large_fd) != 0) return 17;
        return close(large_fd) == 0 ? 0 : 18;
    }
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
